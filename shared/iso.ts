// Isometric camera conventions shared by the stage renderers and the server.
//
// The 3D stage games look down an orthographic camera along a fixed
// direction. Phones send joystick vectors in SCREEN space (right = +x,
// down = +y — what the thumb actually did), and whoever consumes them must
// know how the screen axes land on the ground plane for that camera. Keeping
// the direction and the mapping here means the camera and the controls can
// never drift apart.
//
// World axes: x and z span the ground plane, y is up. A camera sits at
// `center + dir * k` looking back at `center` with y as its up vector.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Medusa: a classic 2:1-ish iso, race axis running up-right.
export const MEDUSA_ISO_DIR: Vec3 = normalize({ x: -0.62, y: 0.85, z: 1 });

// Human Tetris: steeper, so the shape footprint on the ground reads clearly
// and "inside / outside" is never a judgement call for the crowd.
export const TETRIS_ISO_DIR: Vec3 = normalize({ x: -0.55, y: 1.35, z: 1 });

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

// 2x2 matrix mapping a ground-plane vector (wx, wz) to screen (sx, sy):
//   sx = a*wx + b*wz
//   sy = c*wx + d*wz      (screen y grows DOWNWARD)
export interface GroundToScreen {
  a: number;
  b: number;
  c: number;
  d: number;
}

export function groundToScreen(dir: Vec3): GroundToScreen {
  const f = { x: -dir.x, y: -dir.y, z: -dir.z }; // view direction
  const right = normalize(cross(f, { x: 0, y: 1, z: 0 }));
  const up = cross(right, f);
  return { a: right.x, b: right.z, c: -up.x, d: -up.z };
}

// A screen-space joystick vector → ground-plane direction with the SAME
// magnitude. Pushing the thumb "up" on the phone moves the avatar up the
// projector, whatever the iso angle. (The raw inverse is anisotropic — the
// depth axis is foreshortened — so we keep the direction and restore the
// magnitude: full deflection is full speed in every direction.)
export function screenToGround(
  dir: Vec3,
  sx: number,
  sy: number,
): { x: number; z: number } {
  const m = groundToScreen(dir);
  const det = m.a * m.d - m.b * m.c;
  const mag = Math.hypot(sx, sy);
  if (mag < 1e-6 || Math.abs(det) < 1e-9) return { x: 0, z: 0 };
  const wx = (m.d * sx - m.b * sy) / det;
  const wz = (-m.c * sx + m.a * sy) / det;
  const wlen = Math.hypot(wx, wz) || 1;
  return { x: (wx / wlen) * mag, z: (wz / wlen) * mag };
}

// The reverse: a ground-plane direction → where it points on screen, unit
// length. Bots use it to push their (screen-space) joystick like a thumb.
export function groundToScreenDir(
  dir: Vec3,
  wx: number,
  wz: number,
): { x: number; y: number } {
  const m = groundToScreen(dir);
  const sx = m.a * wx + m.b * wz;
  const sy = m.c * wx + m.d * wz;
  const len = Math.hypot(sx, sy) || 1;
  return { x: sx / len, y: sy / len };
}
