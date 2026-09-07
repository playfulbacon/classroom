// Medusa scene art: field, obstacles, ferries, crumble, avatars and their
// motion — kept separate from the stage renderer's staging (head, cameras,
// HUD) so the art layer stays reusable.
//
// World axes: x = race axis (left → right, Medusa at high x), z = lanes
// (screen depth), y = up. One grid cell = 1 world unit.

import * as THREE from 'three';
import type { MedusaSnapshot } from '../../../shared/protocol';
import { MEDUSA_ISO_DIR } from '../../../shared/iso';
import {
  AVATAR_BODY_Y,
  addLights,
  buildAvatar,
  headTint,
  parseColor,
  subCellOffset,
} from './avatar';

// The avatar (body, head, shadow, colours) is shared with the other 3D
// games — see avatar.ts. Medusa dresses it up below.
export { addLights, parseColor, subCellOffset };

export const HOP_DUR = 0.2;

export const ST_RUN = 0;
export const ST_STONE = 1;
export const ST_FINISHED = 2;
export const ST_FALLEN = 3;

// Ferry slab top: a rider stands this far above the ground plane.
export const FERRY_TOP = 0.16;

export const SCENE_BG = 0x10142a;

// The one isometric viewing direction for the stage camera (shared with the
// phone's swipe mapping via shared/iso.ts).
export const ISO_DIR = new THREE.Vector3(MEDUSA_ISO_DIR.x, MEDUSA_ISO_DIR.y, MEDUSA_ISO_DIR.z);

export interface Avatar {
  slot: number;
  group: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  headMat: THREE.MeshLambertMaterial;
  color: string;
  // displayed position (world), animated toward the target cell
  x: number;
  z: number;
  tx: number;
  tz: number;
  hopStart: number; // seconds, -1 when idle
  fromX: number;
  fromZ: number;
  fromY: number; // hop endpoint heights: 0 on ground, FERRY_TOP on a slab
  toY: number;
  // Ferry riding: after a boarding hop lands (attachAfter), the avatar is
  // attached to the platform mesh and follows it continuously.
  onFerry: boolean;
  attachAfter: boolean;
  cellCol: number; // latest server cell (for ferry lookup)
  cellLane: number;
  state: number;
  stoneAt: number;
  fallAt: number; // when the blind hop landed in the pit (sink start)
  tier: number; // 0..2 — how far the stone has crept
  bobPhase: number;
  pingUntil: number;
}

export interface CrumbleCell {
  tile: THREE.Mesh;
  tileMat: THREE.MeshLambertMaterial;
  cracks: THREE.LineSegments;
  hole: THREE.Mesh;
  stage: number;
}

export interface FieldHandles {
  platformMeshes: Map<number, THREE.Mesh>;
  platformDefs: Map<number, { lane: number; c0: number; c1: number }>;
  crumbleCells: Map<number, CrumbleCell>; // key lane*1000+col
  pitKeys: Set<number>; // key lane*1000+col — for ferry detection
}

// Normalized field layout (produced from the stage snapshot).
export interface MedusaFieldLayout {
  length: number;
  lanes: number;
  pits: [number, number][]; // [col, lane], includes chasm band cells
  platforms: { id: number; lane: number; c0: number; c1: number; pos: number }[];
  crumble: [number, number, number][]; // [col, lane, stage]
}

export function layoutFromSnapshot(s: MedusaSnapshot): MedusaFieldLayout {
  return {
    length: s.length,
    lanes: s.lanes,
    pits: s.pits,
    platforms: s.platforms.map(([id, lane, c0, c1, pos]) => ({ id, lane, c0, c1, pos })),
    crumble: s.crumble,
  };
}

// ------------------------------------------------------------------ field
export function buildField(root: THREE.Group, layout: MedusaFieldLayout): FieldHandles {
  const L = layout.length;
  const lanes = layout.lanes;
  const cz = (lanes - 1) / 2;
  const handles: FieldHandles = {
    platformMeshes: new Map(),
    platformDefs: new Map(),
    crumbleCells: new Map(),
    pitKeys: new Set(layout.pits.map(([c, l]) => l * 1000 + c)),
  };

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 14, lanes + 10),
    new THREE.MeshLambertMaterial({ color: 0x2e4a3a }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(L / 2 + 1, -0.02, cz);
  root.add(ground);

  // Subtle grid over the playable field.
  const grid = new THREE.Group();
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.07,
  });
  for (let c = 0; c <= L; c++) {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(c - 0.5, 0, -0.5),
      new THREE.Vector3(c - 0.5, 0, lanes - 0.5),
    ]);
    grid.add(new THREE.Line(g, lineMat));
  }
  for (let l = 0; l <= lanes; l++) {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, 0, l - 0.5),
      new THREE.Vector3(L - 0.5, 0, l - 0.5),
    ]);
    grid.add(new THREE.Line(g, lineMat));
  }
  root.add(grid);

  // Start zone tint + finish strip.
  const startZone = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, lanes),
    new THREE.MeshLambertMaterial({ color: 0x3a5d8a, transparent: true, opacity: 0.5 }),
  );
  startZone.rotation.x = -Math.PI / 2;
  startZone.position.set(0.55, 0.001, cz);
  root.add(startZone);
  const finish = new THREE.Mesh(
    new THREE.PlaneGeometry(1, lanes),
    new THREE.MeshLambertMaterial({ color: 0xd8b64a, transparent: true, opacity: 0.85 }),
  );
  finish.rotation.x = -Math.PI / 2;
  finish.position.set(L - 1, 0.002, cz);
  root.add(finish);

  // Chasm bands (from the ferry routes): one deep gorge slab each instead
  // of per-cell pit squares.
  const bands: { c0: number; c1: number }[] = [];
  for (const { c0, c1 } of layout.platforms) {
    if (!bands.some((b) => b.c0 === c0 && b.c1 === c1)) bands.push({ c0, c1 });
  }
  const inBand = (col: number) => bands.some((b) => col >= b.c0 && col <= b.c1);
  for (const b of bands) {
    const width = b.c1 - b.c0 + 1;
    const gorge = new THREE.Mesh(
      new THREE.PlaneGeometry(width - 0.1, lanes + 2),
      new THREE.MeshLambertMaterial({ color: 0x070a16 }),
    );
    gorge.rotation.x = -Math.PI / 2;
    gorge.position.set((b.c0 + b.c1) / 2, 0.005, cz);
    root.add(gorge);
    for (const edge of [b.c0 - 0.5, b.c1 + 0.5]) {
      const rim = new THREE.Mesh(
        new THREE.PlaneGeometry(0.12, lanes + 2),
        new THREE.MeshLambertMaterial({ color: 0x2a3550 }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(edge, 0.007, cz);
      root.add(rim);
    }
  }

  // Scattered pits: dark recessed squares with a rim.
  const pitTop = new THREE.MeshLambertMaterial({ color: 0x05060d });
  const pitRim = new THREE.MeshLambertMaterial({ color: 0x1b2438 });
  for (const [col, lane] of layout.pits) {
    if (inBand(col)) continue;
    const rim = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), pitRim);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(col, 0.004, lane);
    root.add(rim);
    const hole = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.78), pitTop);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(col, 0.006, lane);
    root.add(hole);
  }

  // Ferry platforms: bronze slabs shuttling across the gorges.
  for (const { id, lane, c0, c1, pos } of layout.platforms) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.14, 0.92),
      new THREE.MeshLambertMaterial({ color: 0xa8763e }),
    );
    slab.position.set(pos, 0.09, lane);
    root.add(slab);
    handles.platformMeshes.set(id, slab);
    handles.platformDefs.set(id, { lane, c0, c1 });
  }

  // Crumbling ground: dry cracked tiles that collapse behind the crowd.
  for (const [col, lane, stage] of layout.crumble) {
    const tileMat = new THREE.MeshLambertMaterial({ color: 0x77704f });
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), tileMat);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(col, 0.005, lane);
    root.add(tile);
    const crackGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(col - 0.3, 0.012, lane - 0.35),
      new THREE.Vector3(col + 0.1, 0.012, lane + 0.05),
      new THREE.Vector3(col + 0.1, 0.012, lane + 0.05),
      new THREE.Vector3(col + 0.32, 0.012, lane + 0.3),
      new THREE.Vector3(col - 0.35, 0.012, lane + 0.25),
      new THREE.Vector3(col + 0.05, 0.012, lane - 0.1),
    ]);
    const cracks = new THREE.LineSegments(
      crackGeo,
      new THREE.LineBasicMaterial({ color: 0x2b2517, transparent: true, opacity: 0.5 }),
    );
    root.add(cracks);
    const hole = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.86), pitTop);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(col, 0.008, lane);
    hole.visible = false;
    root.add(hole);
    const cell: CrumbleCell = { tile, tileMat, cracks, hole, stage: 0 };
    handles.crumbleCells.set(lane * 1000 + col, cell);
    if (stage !== 0) styleCrumble(cell, stage);
  }

  return handles;
}

// Restyle a crumble cell for its stage; `onCollapse` (stage-only dust FX)
// fires when the tile finally gives way.
export function styleCrumble(
  cell: CrumbleCell,
  stage: number,
  onCollapse?: (x: number, z: number) => void,
) {
  cell.stage = stage;
  if (stage === 1) {
    cell.tileMat.color.set(0x5c5138);
    (cell.cracks.material as THREE.LineBasicMaterial).opacity = 0.95;
    cell.tile.rotation.z = 0.02;
  } else if (stage === 2) {
    cell.tile.visible = false;
    cell.cracks.visible = false;
    cell.hole.visible = true;
    onCollapse?.(cell.hole.position.x, cell.hole.position.z);
  }
}

// ----------------------------------------------------------------- avatars
const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8d8d99 });
const stoneDark = new THREE.MeshLambertMaterial({ color: 0x6f6f7a });

export function makeAvatar(slot: number, color: string, parent: THREE.Object3D): Avatar {
  const { group, bodyMat, headMat } = buildAvatar(color, parent);
  // Eye-mode blindfold band: shown while this player runs eyes-closed.
  const blindfold = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.09, 0.4),
    new THREE.MeshLambertMaterial({ color: 0x14161f }),
  );
  blindfold.position.y = 0.87;
  blindfold.name = 'blindfold';
  blindfold.visible = false;
  group.add(blindfold);
  // Stone creeping up the body, tier by tier: feet first, then the legs.
  const stoneFeet = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.16, 10), stoneMat);
  stoneFeet.position.y = 0.1;
  stoneFeet.name = 'stone-feet';
  stoneFeet.visible = false;
  group.add(stoneFeet);
  const stoneLegs = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.26, 10), stoneMat);
  stoneLegs.position.y = 0.3;
  stoneLegs.name = 'stone-legs';
  stoneLegs.visible = false;
  group.add(stoneLegs);
  return {
    slot,
    group,
    bodyMat,
    headMat,
    color,
    x: 0,
    z: 0,
    tx: 0,
    tz: 0,
    hopStart: -1,
    fromX: 0,
    fromZ: 0,
    fromY: 0,
    toY: 0,
    onFerry: false,
    attachAfter: false,
    cellCol: 0,
    cellLane: 0,
    state: ST_RUN,
    stoneAt: 0,
    fallAt: 0,
    tier: 0,
    bobPhase: (slot % 17) * 0.4,
    pingUntil: 0,
  };
}

// Stone creeping up a runner: their colors gray out and stone climbs the
// body tier by tier — feet at tier 1, legs at tier 2 (full statue is the
// state change, not a tier).
export function applyTier(av: Avatar, tier: number) {
  av.tier = tier;
  if (av.state !== ST_RUN) return;
  const base = parseColor(av.color);
  const gray = new THREE.Color(0x8d8d99);
  av.bodyMat.color.copy(base.clone().lerp(gray, tier * 0.38));
  av.headMat.color.copy(headTint(base).lerp(gray, tier * 0.38));
  const feet = av.group.getObjectByName('stone-feet');
  if (feet) feet.visible = tier >= 1;
  const legs = av.group.getObjectByName('stone-legs');
  if (legs) legs.visible = tier >= 2;
}

export function turnToStone(av: Avatar) {
  av.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.name === 'body') mesh.material = stoneMat;
    if (mesh.isMesh && mesh.name === 'head') mesh.material = stoneDark;
  });
}

export function setBlindfold(av: Avatar, on: boolean) {
  const blindfold = av.group.getObjectByName('blindfold');
  if (blindfold) blindfold.visible = on;
}

// One avatar's per-frame motion: hop arc with landing squash, idle bob
// while running, shake when freshly petrified. Ferry-attached avatars are
// positioned by followFerry() instead of the ground branch.
export function updateAvatarMotion(av: Avatar, dt: number, clockT: number) {
  if (av.hopStart >= 0) {
    // Hop interpolation (endpoint heights blend ground ↔ ferry slab).
    const p = Math.min(1, (clockT - av.hopStart) / HOP_DUR);
    av.x = av.fromX + (av.tx - av.fromX) * p;
    av.z = av.fromZ + (av.tz - av.fromZ) * p;
    const hopY = av.fromY + (av.toY - av.fromY) * p + Math.sin(p * Math.PI) * 0.32;
    av.group.position.set(av.x, hopY, av.z);
    // Squash on landing.
    const squash = p > 0.85 ? 1 - (1 - (1 - p) / 0.15) * 0.15 : 1;
    av.group.scale.set(1 / squash, squash, 1 / squash);
    if (p >= 1) {
      av.hopStart = -1;
      av.onFerry = av.attachAfter; // boarding hop landed → ride
      av.attachAfter = false;
      if (av.state === ST_FALLEN) av.fallAt = clockT; // sink starts on landing
    }
  } else if (av.state === ST_FALLEN) {
    // The blind hop landed in open air: sink into the dark, spinning, gone.
    const p = Math.min(1, (clockT - av.fallAt) / 0.55);
    const s = Math.max(0.25, 1 - p * 0.75);
    av.group.position.set(av.x, -1.4 * p * p, av.z);
    av.group.scale.set(s, s, s);
    av.group.rotation.y += dt * 7;
    av.group.visible = p < 1;
    return;
  } else if (!av.onFerry) {
    av.group.position.set(av.x, 0, av.z);
    av.group.scale.set(1, 1, 1);
  }

  if (av.state === ST_RUN) {
    // Idle bob.
    av.bobPhase += dt * 3;
    const body = av.group.getObjectByName('body');
    if (body) body.position.y = AVATAR_BODY_Y + Math.sin(av.bobPhase) * 0.015;
  } else if (av.state === ST_STONE) {
    const since = clockT - av.stoneAt;
    if (since < 0.25) {
      av.group.rotation.z = Math.sin(since * 60) * 0.06 * (1 - since / 0.25);
    } else {
      av.group.rotation.z = 0;
    }
  }
}

// The rider's platform mesh, by the server cell it currently occupies.
export function ferryMeshFor(av: Avatar, handles: FieldHandles): THREE.Mesh | null {
  for (const [id, def] of handles.platformDefs) {
    if (def.lane === av.cellLane && av.cellCol >= def.c0 && av.cellCol <= def.c1) {
      return handles.platformMeshes.get(id) ?? null;
    }
  }
  return null;
}

// A rider between hops is GLUED to the slab: the slab's own motion is
// already smoothed (lerpPlatforms), so copying its position verbatim is
// what makes the ride perfectly smooth — any chasing here would wobble.
export function followFerry(av: Avatar, handles: FieldHandles) {
  const mesh = ferryMeshFor(av, handles);
  if (!mesh) return;
  const [ox, oz] = subCellOffset(av.slot);
  av.x = av.tx = mesh.position.x + ox * 0.3;
  av.z = av.tz = av.cellLane + oz * 0.3;
  av.group.position.set(av.x, FERRY_TOP, av.z);
  av.group.scale.set(1, 1, 1);
}

// Ease ferry slabs toward their latest reported positions.
export function lerpPlatforms(
  handles: FieldHandles,
  targets: Map<number, number>,
  dt: number,
) {
  const k = 1 - Math.exp(-10 * dt);
  for (const [id, mesh] of handles.platformMeshes) {
    const target = targets.get(id);
    if (target !== undefined) mesh.position.x += (target - mesh.position.x) * k;
  }
}
