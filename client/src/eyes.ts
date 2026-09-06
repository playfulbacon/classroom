// On-device eyes-open detection for Medusa's eye mode (code-split — phones
// load this chunk only when the teacher turns the mode on).
//
// Privacy: the camera stream and every frame stay on this device. Detection
// runs locally via MediaPipe FaceLandmarker (WASM); the only thing reported
// out of this module is {open, seen} booleans.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface EyeState {
  open: boolean;
  seen: boolean; // is a face currently visible to the camera?
}

export interface EyeTracker {
  video: HTMLVideoElement; // mirrored self-preview, caller may mount it
  stop(): void;
}

const CLOSE_AT = 0.55; // blink score to flip open → closed
const OPEN_AT = 0.4; // blink score to flip closed → open (hysteresis)
const AGREE_FRAMES = 2; // consecutive frames before a state change commits

export async function startEyeTracking(
  onState: (s: EyeState) => void,
): Promise<EyeTracker | 'denied' | 'unsupported'> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
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
  } catch {
    return 'denied';
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
  } catch {
    for (const track of stream.getTracks()) track.stop();
    return 'unsupported';
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.style.transform = 'scaleX(-1)'; // mirror the self-view
  try {
    await video.play();
  } catch {
    for (const track of stream.getTracks()) track.stop();
    landmarker.close();
    return 'unsupported';
  }

  let stopped = false;
  let open = true;
  let seen = false;
  let candidate: boolean | null = null;
  let agree = 0;
  let lastVideoTime = -1;

  const emit = () => onState({ open, seen });

  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const result = landmarker.detectForVideo(video, performance.now());
        const shapes = result.faceBlendshapes?.[0]?.categories;
        if (!shapes || shapes.length === 0) {
          if (seen) {
            seen = false;
            emit();
          }
        } else {
          let blink = 0;
          let found = 0;
          for (const c of shapes) {
            if (c.categoryName === 'eyeBlinkLeft' || c.categoryName === 'eyeBlinkRight') {
              blink += c.score;
              found++;
            }
          }
          const score = found > 0 ? blink / found : 0;
          const nextOpen = open ? score < CLOSE_AT : score < OPEN_AT;
          let changed = false;
          if (!seen) {
            seen = true;
            changed = true;
          }
          if (nextOpen !== open) {
            if (candidate === nextOpen) agree++;
            else {
              candidate = nextOpen;
              agree = 1;
            }
            if (agree >= AGREE_FRAMES) {
              open = nextOpen;
              candidate = null;
              agree = 0;
              changed = true;
            }
          } else {
            candidate = null;
            agree = 0;
          }
          if (changed) emit();
        }
      } catch {
        // a single bad frame is not worth crashing the loop over
      }
    }
    setTimeout(loop, 66); // ~15fps is plenty for eyelids
  };
  loop();

  return {
    video,
    stop() {
      stopped = true;
      landmarker.close();
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
