// On-device gaze classification for Medusa's eye mode (code-split — phones
// load this chunk only when the teacher turns the mode on).
//
// Privacy: the camera stream and every frame stay on this device. Detection
// runs locally via MediaPipe FaceLandmarker (WASM); the only thing reported
// out of this module is a tiny {state, confidence} pair.
//
// States (mirror the shared GZ_* codes):
//   0 shield  — eyes open, gaze on the phone (safe; move slowly by the shield)
//   1 closed  — eyes closed (safe; move fast, blind)
//   2 caught  — eyes open and off the phone (her gaze meets yours)
//   3 unknown — no face / tracking lost (the server treats this as slow death)

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export type GazeCode = 0 | 1 | 2 | 3;

export interface GazeState {
  s: GazeCode;
  c: number; // confidence 0..1 (matters most for CAUGHT)
}

export interface GazeTracker {
  video: HTMLVideoElement; // mirrored self-preview, caller may mount it
  // Live detection internals (blink score, look delta, head deviation, the
  // on-phone score, raw vs committed state) — mutated every frame, for the
  // ?debug overlay.
  debug: Record<string, string>;
  // Sample ~baseline while the player looks at their phone; resolves true
  // when enough face frames were collected. Uncalibrated defaults still work.
  calibrate(ms?: number): Promise<boolean>;
  stop(): void;
}

// Why the camera pipeline couldn't start — `detail` names the failing step.
export interface GazeFailure {
  error: 'denied' | 'unsupported';
  detail: string;
}

const CLOSE_AT = 0.55; // blink score to flip open → closed
const OPEN_AT = 0.4; // blink score to flip closed → open (hysteresis)
const SHIELD_ENTER = 0.55; // on-phone score to (re)enter shield
const SHIELD_EXIT = 0.45; // below this, eyes have left the phone
const CAUGHT_FRAMES = 3; // false CAUGHT is the costly error — demand agreement
const AGREE_FRAMES = 2; // other transitions commit faster

export async function startGazeTracking(
  onState: (s: GazeState) => void,
): Promise<GazeTracker | GazeFailure> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      error: 'unsupported',
      detail: 'no mediaDevices API — the camera needs HTTPS or localhost',
    };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 15 },
      },
      audio: false,
    });
  } catch (err) {
    const e = err as DOMException;
    return { error: 'denied', detail: `getUserMedia ${e.name}: ${e.message}` };
  }

  let landmarker: FaceLandmarker;
  try {
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe-wasm');
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    return {
      error: 'unsupported',
      detail: `FaceLandmarker init failed: ${(err as Error).message?.slice(0, 120)}`,
    };
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.style.transform = 'scaleX(-1)'; // mirror the self-view
  try {
    await video.play();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    landmarker.close();
    return {
      error: 'unsupported',
      detail: `video.play failed: ${(err as Error).message?.slice(0, 120)}`,
    };
  }

  // Calibration baseline: what "looking at my phone" measures like for this
  // player, this grip, this lighting. Defaults assume a phone held a little
  // below the face.
  let baseLook = 0.2; // eyeLookDown minus eyeLookUp while on the phone
  const baseForward = { x: 0, y: 0, z: 1 }; // head forward vector at baseline
  let calibrating: { until: number; look: number[]; f: { x: number; y: number; z: number }[] } | null =
    null;

  const debug: Record<string, string> = {};
  let stopped = false;
  let committed: GazeCode = 3;
  let candidate: GazeCode | null = null;
  let agree = 0;
  let lastConf = 1;
  let closed = false; // blink hysteresis memory
  let lastVideoTime = -1;

  const shape = (cats: { categoryName: string; score: number }[], name: string) => {
    for (const c of cats) if (c.categoryName === name) return c.score;
    return 0;
  };

  // Raw classification for one frame.
  const classify = (): GazeState => {
    const result = landmarker.detectForVideo(video, performance.now());
    const cats = result.faceBlendshapes?.[0]?.categories;
    if (!cats || cats.length === 0) {
      debug.face = 'NOT SEEN';
      return { s: 3, c: 1 };
    }
    debug.face = 'seen';

    const blink = (shape(cats, 'eyeBlinkLeft') + shape(cats, 'eyeBlinkRight')) / 2;
    closed = closed ? blink > OPEN_AT : blink > CLOSE_AT;
    debug.blink = `${blink.toFixed(2)} → ${closed ? 'CLOSED' : 'open'}`;
    if (closed) return { s: 1, c: 1 };

    // Eyes are open — are they on the phone? Two signals, both measured as
    // deviation from the calibrated baseline:
    //  - vertical eye direction (lookDown - lookUp blendshapes),
    //  - head forward vector from the face transformation matrix.
    const lookDelta =
      (shape(cats, 'eyeLookDownLeft') + shape(cats, 'eyeLookDownRight')) / 2 -
      (shape(cats, 'eyeLookUpLeft') + shape(cats, 'eyeLookUpRight')) / 2;
    let angleDev = 0;
    const m = result.facialTransformationMatrixes?.[0]?.data;
    let fx = 0;
    let fy = 0;
    let fz = 1;
    if (m && m.length >= 12) {
      // Column-major 4x4: the third column is the head's forward axis.
      const len = Math.hypot(m[8], m[9], m[10]) || 1;
      fx = m[8] / len;
      fy = m[9] / len;
      fz = m[10] / len;
      const dot = Math.max(
        -1,
        Math.min(1, fx * baseForward.x + fy * baseForward.y + fz * baseForward.z),
      );
      angleDev = Math.acos(dot);
    }
    if (calibrating) {
      calibrating.look.push(lookDelta);
      calibrating.f.push({ x: fx, y: fy, z: fz });
    }

    const eyePart = Math.max(0, Math.min(1, 0.5 + (lookDelta - baseLook) * 1.5));
    const headPart = Math.max(0, Math.min(1, 1 - angleDev / 0.5));
    const g = 0.6 * eyePart + 0.4 * headPart;
    debug.look = `Δ${lookDelta.toFixed(2)} (base ${baseLook.toFixed(2)})`;
    debug.head = `dev ${((angleDev * 180) / Math.PI).toFixed(0)}°`;
    debug.onPhone = `g=${g.toFixed(2)} (enter ${SHIELD_ENTER} exit ${SHIELD_EXIT})`;
    const wasShield = committed === 0 || candidate === 0;
    if (g >= (wasShield ? SHIELD_EXIT : SHIELD_ENTER)) return { s: 0, c: 1 };
    // Off the phone with open eyes: caught, confidence by how clearly off.
    return { s: 2, c: Math.max(0.1, Math.min(1, (SHIELD_EXIT - g) / 0.25)) };
  };

  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const { s, c } = classify();
        lastConf = c;
        debug.raw = `${['shield', 'closed', 'caught', 'unknown'][s]} c=${c.toFixed(2)}`;
        debug.committed = ['shield', 'closed', 'caught', 'unknown'][committed];
        if (s !== committed) {
          if (candidate === s) agree++;
          else {
            candidate = s;
            agree = 1;
          }
          if (agree >= (s === 2 ? CAUGHT_FRAMES : AGREE_FRAMES)) {
            committed = s;
            candidate = null;
            agree = 0;
            onState({ s, c });
          }
        } else {
          candidate = null;
          agree = 0;
        }
      } catch {
        // a single bad frame is not worth crashing the loop over
      }
    }
    setTimeout(loop, 66); // ~15fps is plenty
  };
  loop();

  return {
    video,
    debug,
    async calibrate(ms = 1500) {
      calibrating = { until: performance.now() + ms, look: [], f: [] };
      await new Promise((r) => setTimeout(r, ms));
      const cal = calibrating;
      calibrating = null;
      if (!cal || cal.look.length < 5) return false;
      baseLook = cal.look.reduce((a, b) => a + b, 0) / cal.look.length;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const f of cal.f) {
        sx += f.x;
        sy += f.y;
        sz += f.z;
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      baseForward.x = sx / len;
      baseForward.y = sy / len;
      baseForward.z = sz / len;
      // Re-announce the current state against the new baseline.
      onState({ s: committed, c: lastConf });
      return true;
    },
    stop() {
      stopped = true;
      landmarker.close();
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
