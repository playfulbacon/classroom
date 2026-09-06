# Drop-in 3D models

## medusa.glb

Place a glTF binary (`medusa.glb`) in this folder and the Medusa game will
use it as her head at the end of the field. Guidelines:

- Face the model toward **+Z** (the loader rotates it to look down the field).
- Any size works — it is auto-scaled to ~3 world units tall and centered.
- Keep it light for quick loads: ≤2–3MB, ideally with baked/simple materials.

If the file is missing or fails to load, a built-in stylized head (sphere +
snake hair + glowing eyes) is used instead, so the game always works.

## face_landmarker.task

The committed `face_landmarker.task` (~3.7MB) is Google's MediaPipe Face
Landmarker model (float16), used by **Medusa eye mode** to tell whether a
player's eyes are open. It is loaded lazily on phones — only in Medusa
rounds, only when eye mode is on, only after the player consents. All
inference runs on the device; the video stream never leaves the phone.

To update it, download a newer bundle from the MediaPipe models repository
(`storage.googleapis.com/mediapipe-models/face_landmarker/...`) and replace
the file. The matching wasm runtime is copied from
`@mediapipe/tasks-vision` at build time into `dist/mediapipe-wasm/`.
