// On-device eyes-open detection for Medusa's eye mode (code-split — phones
// load this chunk only when the teacher turns the mode on).
//
// Privacy: the camera stream and every frame stay on this device. Detection
// runs locally via MediaPipe FaceLandmarker (WASM); the only thing reported
// out of this module is a tiny {state, confidence} pair.
//
// States (mirror the shared GZ_* codes) — the rule is pure open/closed:
//   1 closed  — eyes closed (safe during red; move blind)
//   2 open    — eyes open (her gaze meets yours during red)
//   3 unknown — no face / tracking lost (the server treats this as slow death)

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export type GazeCode = 1 | 2 | 3;

export interface GazeState {
  s: GazeCode;
  c: number; // confidence 0..1
}

export interface GazeTracker {
  video: HTMLVideoElement; // mirrored self-preview, caller may mount it
  // Live detection internals (face seen, blink score, raw vs committed
  // state) — mutated every frame, for the 🐞 debug overlay.
  debug: Record<string, string>;
  stop(): void;
}

// Why the camera pipeline couldn't start — `detail` names the failing step.
export interface GazeFailure {
  error: 'denied' | 'unsupported';
  detail: string;
}

const CLOSE_AT = 0.55; // blink score to flip open → closed
const OPEN_AT = 0.4; // blink score to flip closed → open (hysteresis)
const AGREE_FRAMES = 2; // consecutive frames before a state change commits

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

  const debug: Record<string, string> = {};
  let stopped = false;
  let committed: GazeCode = 3;
  let candidate: GazeCode | null = null;
  let agree = 0;
  let closed = false; // blink hysteresis memory
  let lastVideoTime = -1;

  const shape = (cats: { categoryName: string; score: number }[], name: string) => {
    for (const c of cats) if (c.categoryName === name) return c.score;
    return 0;
  };

  // Raw classification for one frame: no face → unknown; otherwise the
  // blink score with hysteresis decides closed vs open.
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
    debug.blink = `${blink.toFixed(2)} → ${closed ? 'CLOSED' : 'open'} (close>${CLOSE_AT} open<${OPEN_AT})`;
    if (closed) return { s: 1, c: Math.min(1, blink / CLOSE_AT) };
    return { s: 2, c: Math.min(1, (CLOSE_AT - blink) / CLOSE_AT + 0.4) };
  };

  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const { s, c } = classify();
        if (s !== committed) {
          if (candidate === s) agree++;
          else {
            candidate = s;
            agree = 1;
          }
          if (agree >= AGREE_FRAMES) {
            committed = s;
            candidate = null;
            agree = 0;
            onState({ s, c });
          }
        } else {
          candidate = null;
          agree = 0;
        }
        debug.state = `${['', 'CLOSED', 'OPEN', 'UNKNOWN'][committed]}`;
      } catch {
        // a single bad frame is not worth crashing the loop over
      }
    }
    setTimeout(loop, 66); // ~15fps is plenty for eyelids
  };
  loop();

  return {
    video,
    debug,
    stop() {
      stopped = true;
      landmarker.close();
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
