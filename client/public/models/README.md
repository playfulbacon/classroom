# Drop-in 3D models

## medusa.glb

Place a glTF binary (`medusa.glb`) in this folder and the Medusa game will
use it as her head at the end of the field. Guidelines:

- Face the model toward **+Z** (the loader rotates it to look down the field).
- Any size works — it is auto-scaled to ~3 world units tall and centered.
- Keep it light for quick loads: ≤2–3MB, ideally with baked/simple materials.

If the file is missing or fails to load, a built-in stylized head (sphere +
snake hair + glowing eyes) is used instead, so the game always works.
