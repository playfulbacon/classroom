// The shared player avatar for the 3D stage games: a capsule body with a
// sphere head and a soft ground shadow, in the player's colour. Medusa
// dresses it with blindfolds and creeping stone; Human Tetris squashes it
// under the wall. Keep the silhouette here so every game's crowd reads the
// same, and so an upgrade (hats, faces, a real rig) lands everywhere at
// once.
//
// World units: one grid cell = one unit; the avatar stands about one unit
// tall with its feet at y = 0.

import * as THREE from 'three';

export const AVATAR_BODY_Y = 0.42;
export const AVATAR_HEAD_Y = 0.84;
export const AVATAR_TOP = 1.02; // head crown — where a label or a rider goes

export interface AvatarParts {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  shadow: THREE.Mesh;
  bodyMat: THREE.MeshLambertMaterial;
  headMat: THREE.MeshLambertMaterial;
}

export interface AvatarOptions {
  // Head tint blends the base colour toward white by this much (0..1).
  headLighten?: number;
  // Overall size multiplier (NPCs ride a little smaller).
  scale?: number;
}

// Player colors use modern space-separated hsl() syntax, which THREE.Color
// cannot parse — convert explicitly.
export function parseColor(css: string): THREE.Color {
  const m = /hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)/.exec(css);
  if (m) {
    return new THREE.Color().setHSL(
      Number(m[1]) / 360,
      Number(m[2]) / 100,
      Number(m[3]) / 100,
      THREE.SRGBColorSpace,
    );
  }
  return new THREE.Color(css);
}

export function headTint(base: THREE.Color, lighten = 0.35): THREE.Color {
  return base.clone().lerp(new THREE.Color('#ffffff'), lighten);
}

export function buildAvatar(
  color: string | THREE.Color,
  parent: THREE.Object3D,
  opts: AvatarOptions = {},
): AvatarParts {
  const base = typeof color === 'string' ? parseColor(color) : color.clone();
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: base });
  const headMat = new THREE.MeshLambertMaterial({ color: headTint(base, opts.headLighten ?? 0.35) });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.3, 3, 8), bodyMat);
  body.position.y = AVATAR_BODY_Y;
  body.name = 'body';
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), headMat);
  head.position.y = AVATAR_HEAD_Y;
  head.name = 'head';
  group.add(head);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.28, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  shadow.name = 'shadow';
  group.add(shadow);
  if (opts.scale && opts.scale !== 1) group.scale.setScalar(opts.scale);
  parent.add(group);
  return { group, body, head, shadow, bodyMat, headMat };
}

// Deterministic scatter inside a cell so piled players read as a cluster.
export function subCellOffset(slot: number): [number, number] {
  const a = ((slot * 2654435761) >>> 0) / 4294967296;
  const b = (((slot * 40503 + 12345) >>> 0) & 0xffff) / 65536;
  return [(a - 0.5) * 0.56, (b - 0.5) * 0.56];
}

// The stage games share one lighting rig so the avatar looks the same
// everywhere.
export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xbcc7ff, 0x2a2f45, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
  sun.position.set(-18, 30, 14);
  scene.add(sun);
}

// Idle breathing: a tiny body bob. Call every frame with the avatar's own
// phase accumulator.
export function bobBody(parts: { body: THREE.Mesh }, phase: number) {
  parts.body.position.y = AVATAR_BODY_Y + Math.sin(phase) * 0.015;
}
