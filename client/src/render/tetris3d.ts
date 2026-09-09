// Human Tetris stage renderer: the same orthographic three.js setup as
// Medusa (code-split — only the stage loads this chunk, only when a round
// starts). One field, the crowd as shared avatars, the safe shape drawn on
// the ground, and the wall — every cell of the field EXCEPT the shape —
// hovering as a ghost, dropping out of the sky at zero, resting while the
// crushed are counted, then lifting back out of frame.
//
// World axes: x = field width (left → right), z = field depth (screen
// down), y = up. One field cell = one world unit; cell (cx, cz) spans
// [cx, cx+1) × [cz, cz+1), so its centre is at (cx + 0.5, cz + 0.5).

import * as THREE from 'three';
import {
  NPC_CARRIED,
  NPC_CRUSHED,
  NPC_SAVED,
  NPC_WAITING,
  TETRIS_ALIVE,
  TETRIS_DROP_DUR as DROP_DUR,
  TETRIS_OUT,
  TETRIS_RISE_DUR as RISE_DUR,
  type RoomState,
  type TetrisShape,
  type TetrisSnapshot,
} from '../../../shared/protocol';
import { TETRIS_ISO_DIR } from '../../../shared/iso';
import * as sfx from '../sfx';
import { AVATAR_TOP, addLights, buildAvatar, type AvatarParts } from './avatar';

const ISO_DIR = new THREE.Vector3(TETRIS_ISO_DIR.x, TETRIS_ISO_DIR.y, TETRIS_ISO_DIR.z);
const SCENE_BG = 0x121a2e;
const HOVER_Y = 6; // where the ghost wall waits
const RISE_Y = 18; // where it goes when it leaves
const WALL_H = 1.25; // just over head height: the survivors peek out of the cut-out
const DANGER_AT = 3; // last seconds: the outside reddens, the timer shouts
const SHAPE_COLOR = 0x5cff9b;
const WALL_COLOR = 0x7a5cff;
const NPC_COLOR = '#f3e7bf';

interface Avatar {
  slot: number;
  parts: AvatarParts;
  color: string;
  x: number;
  z: number;
  tx: number;
  tz: number;
  vx: number;
  vz: number;
  state: number;
  outAt: number; // when the wall lands on them (squash start), Infinity otherwise
  bob: number;
  pingUntil: number;
  carrying: number;
}

interface NpcAvatar {
  id: number;
  parts: AvatarParts;
  x: number;
  z: number;
  tx: number;
  tz: number;
  state: number;
  carrier: number;
  attachedTo: number; // slot whose avatar group holds this NPC (0 = field)
  bob: number;
  doneAt: number; // squash / celebration start, Infinity until the wall lands
}

interface OneShot {
  mesh: THREE.Object3D;
  start: number;
  dur: number;
  update: (p: number) => void;
}

export interface TetrisRenderer3D {
  mount(container: HTMLElement): void;
  push(snap: TetrisSnapshot): void;
  frame(): void;
  dispose(): void;
}

export function createTetrisRenderer(getRoom: () => RoomState | null): TetrisRenderer3D {
  let container: HTMLElement | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let overlay: HTMLCanvasElement | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let fieldRoot: THREE.Group | null = null;
  let shapeRoot: THREE.Group | null = null;
  let actorsRoot: THREE.Group | null = null;

  let snap: TetrisSnapshot | null = null;
  let built = false;
  let shapeKey = '';
  let wallGroup: THREE.Group | null = null;
  let wallMat: THREE.MeshLambertMaterial | null = null;
  let dangerMat: THREE.MeshBasicMaterial | null = null;
  let tileMat: THREE.MeshBasicMaterial | null = null;
  const avatars = new Map<number, Avatar>();
  const npcs = new Map<number, NpcAvatar>();
  const oneShots: OneShot[] = [];

  let lastNow = 0;
  let clockT = 0;
  let lastPhase = '';
  let lastRoundKey = ''; // `${round}:${roundPhase}` — a new round re-enters 'form'
  let phaseStartT = 0; // clockT at which the current round phase began
  let lastTickSecond = -1;
  let shakeUntil = 0;
  let landedThisRound = false;
  let bannerUntil = 0;
  let bannerText = '';
  let bannerColor = '#ffffff';

  const camCenter = new THREE.Vector3(8, 0.5, 5);
  let camHalfW = 12;
  let camAspect = 16 / 9;

  function mount(el: HTMLElement) {
    container = el;
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    el.appendChild(renderer.domElement);
    overlay = document.createElement('canvas');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';
    el.appendChild(overlay);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(SCENE_BG);
    scene.fog = new THREE.Fog(SCENE_BG, 60, 120);
    camera = new THREE.OrthographicCamera(-12, 12, 7, -7, 0.1, 300);
    addRoots();
    addLights(scene);
  }

  function addRoots() {
    if (!scene) return;
    fieldRoot = new THREE.Group();
    shapeRoot = new THREE.Group();
    actorsRoot = new THREE.Group();
    scene.add(fieldRoot, shapeRoot, actorsRoot);
  }

  function resetGame() {
    if (!scene) return;
    scene.clear();
    addRoots();
    addLights(scene);
    avatars.clear();
    npcs.clear();
    oneShots.length = 0;
    built = false;
    shapeKey = '';
    wallGroup = null;
    wallMat = null;
    dangerMat = null;
    tileMat = null;
    lastRoundKey = '';
    lastTickSecond = -1;
    landedThisRound = false;
    bannerUntil = 0;
  }

  // -------------------------------------------------------------- field
  function buildField(W: number, D: number) {
    if (!fieldRoot) return;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(W + 16, D + 16),
      new THREE.MeshLambertMaterial({ color: 0x24344a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, -0.03, D / 2);
    fieldRoot.add(ground);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshLambertMaterial({ color: 0x31485c }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, -0.01, D / 2);
    fieldRoot.add(floor);
    const grid = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 });
    for (let c = 0; c <= W; c++) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c, 0, 0),
        new THREE.Vector3(c, 0, D),
      ]);
      grid.add(new THREE.Line(g, lineMat));
    }
    for (let r = 0; r <= D; r++) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, r),
        new THREE.Vector3(W, 0, r),
      ]);
      grid.add(new THREE.Line(g, lineMat));
    }
    fieldRoot.add(grid);
    // A low kerb around the field.
    const kerbMat = new THREE.MeshLambertMaterial({ color: 0x4a6480 });
    for (const [x, z, w, d] of [
      [W / 2, -0.1, W + 0.4, 0.2],
      [W / 2, D + 0.1, W + 0.4, 0.2],
      [-0.1, D / 2, 0.2, D],
      [W + 0.1, D / 2, 0.2, D],
    ]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), kerbMat);
      kerb.position.set(x, 0.06, z);
      fieldRoot.add(kerb);
    }
    camCenter.set(W / 2, 0.5, D / 2);
    fitCamera(W, D);
  }

  // Frame the whole field once (plus a little headroom): the crowd must
  // always be able to see every corner and the shape at a glance.
  function fitCamera(W: number, D: number) {
    if (!camera) return;
    camera.position.copy(camCenter).addScaledVector(ISO_DIR, 60);
    camera.lookAt(camCenter);
    camera.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(camera.matrixWorldInverse);
    let needW = 4;
    let needH = 3;
    const v = new THREE.Vector3();
    for (const px of [-1, W + 1]) {
      for (const pz of [-1, D + 1]) {
        for (const py of [0, 2.6]) {
          v.set(px, py, pz).applyMatrix4(inv);
          needW = Math.max(needW, Math.abs(v.x));
          needH = Math.max(needH, Math.abs(v.y));
        }
      }
    }
    camHalfW = Math.max(needW, needH * camAspect) * 1.04;
    camera.left = -camHalfW;
    camera.right = camHalfW;
    camera.top = camHalfW / camAspect;
    camera.bottom = -camHalfW / camAspect;
    camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------- shape
  function inShape(shape: TetrisShape, cx: number, cz: number): boolean {
    const c = cx - shape.x0;
    const r = cz - shape.z0;
    if (c < 0 || r < 0 || c >= shape.w || r >= shape.h) return false;
    return shape.rows[r][c] === '1';
  }

  function buildShape(s: TetrisSnapshot, shape: TetrisShape) {
    if (!shapeRoot) return;
    shapeRoot.clear();
    const W = s.fieldW;
    const D = s.fieldD;
    const cells: [number, number][] = [];
    for (let r = 0; r < shape.h; r++) {
      for (let c = 0; c < shape.w; c++) {
        if (shape.rows[r][c] === '1') cells.push([shape.x0 + c, shape.z0 + r]);
      }
    }
    const m = new THREE.Matrix4();

    // Safe floor tiles.
    tileMat = new THREE.MeshBasicMaterial({
      color: SHAPE_COLOR,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.96, 0.96), tileMat, cells.length);
    cells.forEach(([cx, cz], i) => {
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(cx + 0.5, 0.015, cz + 0.5);
      tiles.setMatrixAt(i, m);
    });
    shapeRoot.add(tiles);

    // The outline: a bright kerb on every edge between inside and outside.
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xc8ffdc });
    const hEdges: [number, number][] = []; // along x, at z
    const vEdges: [number, number][] = []; // along z, at x
    for (const [cx, cz] of cells) {
      if (!inShape(shape, cx, cz - 1)) hEdges.push([cx, cz]);
      if (!inShape(shape, cx, cz + 1)) hEdges.push([cx, cz + 1]);
      if (!inShape(shape, cx - 1, cz)) vEdges.push([cx, cz]);
      if (!inShape(shape, cx + 1, cz)) vEdges.push([cx + 1, cz]);
    }
    const hMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.06, 0.08, 0.1), edgeMat, hEdges.length);
    hEdges.forEach(([x, z], i) => {
      m.identity();
      m.setPosition(x + 0.5, 0.04, z);
      hMesh.setMatrixAt(i, m);
    });
    const vMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.08, 1.06), edgeMat, vEdges.length);
    vEdges.forEach(([x, z], i) => {
      m.identity();
      m.setPosition(x, 0.04, z + 0.5);
      vMesh.setMatrixAt(i, m);
    });
    shapeRoot.add(hMesh, vMesh);

    // Everything else is the wall (one cell beyond the field too, so it
    // reads as a slab, not a stencil).
    const outside: [number, number][] = [];
    for (let cx = -1; cx <= W; cx++) {
      for (let cz = -1; cz <= D; cz++) {
        if (!inShape(shape, cx, cz)) outside.push([cx, cz]);
      }
    }
    wallMat = new THREE.MeshLambertMaterial({
      color: WALL_COLOR,
      transparent: true,
      opacity: 0.16,
    });
    const wall = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), wallMat, outside.length);
    outside.forEach(([cx, cz], i) => {
      m.identity();
      m.setPosition(cx + 0.5, WALL_H / 2, cz + 0.5);
      wall.setMatrixAt(i, m);
    });
    wallGroup = new THREE.Group();
    wallGroup.add(wall);
    wallGroup.position.y = HOVER_Y;
    shapeRoot.add(wallGroup);

    // The wall's shadow: the outside reddens in the last seconds.
    dangerMat = new THREE.MeshBasicMaterial({
      color: 0xff3b4d,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const inField = outside.filter(([cx, cz]) => cx >= 0 && cz >= 0 && cx < W && cz < D);
    const danger = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dangerMat, inField.length);
    inField.forEach(([cx, cz], i) => {
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(cx + 0.5, 0.012, cz + 0.5);
      danger.setMatrixAt(i, m);
    });
    shapeRoot.add(danger);
  }

  // ------------------------------------------------------------ avatars
  function makePlayer(slot: number, color: string): Avatar | null {
    if (!actorsRoot) return null;
    const parts = buildAvatar(color, actorsRoot);
    return {
      slot,
      parts,
      color,
      x: 0,
      z: 0,
      tx: 0,
      tz: 0,
      vx: 0,
      vz: 0,
      state: TETRIS_ALIVE,
      outAt: Infinity,
      bob: (slot % 17) * 0.4,
      pingUntil: 0,
      carrying: 0,
    };
  }

  function makeNpc(id: number): NpcAvatar | null {
    if (!actorsRoot) return null;
    const parts = buildAvatar(NPC_COLOR, actorsRoot, { headLighten: 0.1, scale: 0.9 });
    // A little pointed hat so the lost ones stand out from the crowd.
    const hat = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.3, 8),
      new THREE.MeshLambertMaterial({ color: 0xff6b5c }),
    );
    hat.position.y = AVATAR_TOP + 0.08;
    hat.name = 'hat';
    parts.group.add(hat);
    return {
      id,
      parts,
      x: 0,
      z: 0,
      tx: 0,
      tz: 0,
      state: NPC_WAITING,
      carrier: 0,
      attachedTo: 0,
      bob: (id % 7) * 0.9,
      doneAt: Infinity,
    };
  }

  // Put an NPC on a carrier's shoulders (or back on the field).
  function attachNpc(n: NpcAvatar, carrier: Avatar | null) {
    const g = n.parts.group;
    g.parent?.remove(g);
    if (carrier) {
      carrier.parts.group.add(g);
      g.position.set(0, AVATAR_TOP - 0.02, 0);
      g.scale.setScalar(0.72);
      g.rotation.set(0, 0, 0);
      n.attachedTo = carrier.slot;
    } else if (actorsRoot) {
      actorsRoot.add(g);
      g.scale.setScalar(0.9);
      n.attachedTo = 0;
      g.position.set(n.x, 0, n.z);
    }
  }

  function grayOut(parts: AvatarParts) {
    parts.bodyMat.color.set(0x6d6d78);
    parts.headMat.color.set(0x8a8a96);
  }

  // A flattened figure: squashed under the slab, then it sinks away.
  function squashMotion(g: THREE.Object3D, since: number) {
    const p = Math.min(1, since / 0.12);
    const sy = 1 - p * 0.86;
    const sxz = 1 + p * 0.45;
    g.scale.set(sxz, sy, sxz);
    if (since > 2.4) {
      const q = Math.min(1, (since - 2.4) / 0.8);
      g.position.y = -0.4 * q;
      g.visible = q < 1;
    }
  }

  // ---------------------------------------------------------- one-shots
  function spawnRing(x: number, z: number, color: string) {
    if (!actorsRoot) return;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.03, z);
    actorsRoot.add(mesh);
    oneShots.push({
      mesh,
      start: clockT,
      dur: 1.1,
      update: (p) => {
        mesh.scale.setScalar(1 + p * 4);
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
      },
    });
  }

  function spawnDust(x: number, z: number, n = 6) {
    if (!actorsRoot) return;
    for (let i = 0; i < n; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xb8b0a0, transparent: true, opacity: 0.8 }),
      );
      const a = Math.random() * Math.PI * 2;
      const r = 0.2 + Math.random() * 0.3;
      puff.position.set(x, 0.1, z);
      actorsRoot.add(puff);
      const vx = Math.cos(a) * r;
      const vz = Math.sin(a) * r;
      oneShots.push({
        mesh: puff,
        start: clockT,
        dur: 0.7,
        update: (p) => {
          puff.position.set(x + vx * p * 2.4, 0.1 + p * 0.6 - p * p * 0.5, z + vz * p * 2.4);
          puff.scale.setScalar(1 + p);
          (puff.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - p);
        },
      });
    }
  }

  function updateOneShots() {
    for (let i = oneShots.length - 1; i >= 0; i--) {
      const shot = oneShots[i];
      const p = (clockT - shot.start) / shot.dur;
      if (p >= 1) {
        shot.mesh.parent?.remove(shot.mesh);
        oneShots.splice(i, 1);
      } else {
        shot.update(p);
      }
    }
  }

  function banner(text: string, color: string, dur: number) {
    bannerText = text;
    bannerColor = color;
    bannerUntil = clockT + dur;
  }

  // ---------------------------------------------------------------- push
  function push(s: TetrisSnapshot) {
    if (s.phase === 'countdown' && lastPhase === 'over') resetGame();
    const room = getRoom();
    const colors = new Map<number, string>();
    if (room) for (const p of room.players) colors.set(p.id, p.color);

    if (!built && scene) {
      buildField(s.fieldW, s.fieldD);
      built = true;
    }

    // Round phase transitions drive the wall, the sounds and the banners.
    const roundKey = `${s.round}:${s.roundPhase}`;
    if (roundKey === lastRoundKey) {
      // Keep the local phase clock honest against the server's: a throttled
      // tab (or a long frame) must never make the stage timer lie.
      const drift = clockT - phaseStartT - s.pt;
      if (Math.abs(drift) > 0.12) phaseStartT = clockT - s.pt;
      else phaseStartT += drift * 0.1;
    } else {
      phaseStartT = clockT - s.pt;
      if (s.roundPhase === 'form') {
        landedThisRound = false;
        lastTickSecond = -1;
        if (s.phase === 'play') {
          sfx.green();
          banner(`ROUND ${s.round} — FILL THE SHAPE`, '#c8ffdc', 1.6);
        }
      } else if (s.roundPhase === 'drop') {
        sfx.whoosh(DROP_DUR);
        bannerUntil = 0;
      }
      lastRoundKey = roundKey;
    }
    if (s.phase !== lastPhase) {
      if (s.phase === 'over') sfx.gong();
      lastPhase = s.phase;
    }

    if (s.shape) {
      const key = `${s.round}:${s.shape.x0},${s.shape.z0}:${s.shape.rows.join('/')}`;
      if (key !== shapeKey) {
        shapeKey = key;
        buildShape(s, s.shape);
      }
    }

    // Players.
    for (const [slot, x, z, state, carrying] of s.players) {
      let av = avatars.get(slot);
      if (!av) {
        const made = makePlayer(slot, colors.get(slot) ?? '#999');
        if (!made) continue;
        av = made;
        av.x = av.tx = x;
        av.z = av.tz = z;
        av.parts.group.position.set(x, 0, z);
        avatars.set(slot, av);
      }
      av.tx = x;
      av.tz = z;
      if (carrying !== av.carrying) {
        if (carrying && !av.carrying && s.phase === 'play') sfx.blip();
        av.carrying = carrying;
      }
      if (state !== av.state) {
        av.state = state;
        if (state === TETRIS_OUT) {
          // The wall is still falling: the squash starts when it lands.
          av.outAt = phaseStartT + DROP_DUR;
        }
      }
    }
    // NPCs.
    const seen = new Set<number>();
    for (const [id, x, z, state, carrier] of s.npcs) {
      seen.add(id);
      let n = npcs.get(id);
      if (!n) {
        const made = makeNpc(id);
        if (!made) continue;
        n = made;
        n.x = n.tx = x;
        n.z = n.tz = z;
        n.parts.group.position.set(x, 0, z);
        npcs.set(id, n);
        if (s.phase === 'play' && s.roundPhase === 'form') spawnRing(x, z, '#ffe066');
      }
      n.tx = x;
      n.tz = z;
      n.carrier = carrier;
      if (state !== n.state) {
        if (state === NPC_SAVED || state === NPC_CRUSHED) n.doneAt = phaseStartT + DROP_DUR;
        n.state = state;
      }
      // Riders stay on their carrier's shoulders through the landing —
      // saved ones celebrate up there, crushed ones go down with them.
      const wantAttach = carrier !== 0 && state !== NPC_WAITING;
      const carrierAv = wantAttach ? avatars.get(carrier) ?? null : null;
      if (carrierAv && n.attachedTo !== carrier) attachNpc(n, carrierAv);
      else if (!carrierAv && n.attachedTo !== 0) attachNpc(n, null);
    }
    for (const [id, n] of npcs) {
      if (seen.has(id)) continue;
      n.parts.group.parent?.remove(n.parts.group);
      npcs.delete(id);
    }

    for (const slot of s.pings) {
      const av = avatars.get(slot);
      if (av) {
        av.pingUntil = clockT + 1.6;
        spawnRing(av.x, av.z, av.color);
      }
    }
    snap = s;
  }

  // -------------------------------------------------------------- frame
  function frame() {
    if (!renderer || !scene || !camera || !container || !overlay) return;
    const now = performance.now() / 1000;
    const dt = lastNow ? Math.min(0.1, now - lastNow) : 0.016;
    lastNow = now;
    clockT += dt;
    const s = snap;
    if (!s) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(h * dpr);
      camAspect = w / h;
      fitCamera(s.fieldW, s.fieldD);
    }

    const elapsed = clockT - phaseStartT;
    updateWall(s, elapsed);
    updateActors(s, dt);
    updateOneShots();

    // Landing: dust under everyone the wall took, a thud, a shake.
    if (s.roundPhase !== 'form' && !landedThisRound && elapsed >= DROP_DUR) {
      landedThisRound = true;
      const crushed = s.lastCrushed[0].length + s.lastCrushed[1].length;
      sfx.thud(crushed > 0);
      shakeUntil = clockT + 0.35;
      for (const slot of s.lastCrushed[0]) {
        const av = avatars.get(slot);
        if (av) spawnDust(av.x, av.z);
      }
      for (const id of s.lastCrushed[1]) {
        const n = npcs.get(id);
        if (n && n.attachedTo === 0) spawnDust(n.x, n.z);
      }
      if (s.phase === 'over') {
        banner('THE WALL WINS', '#ff5964', 3);
      } else if (crushed === 0) {
        sfx.fanfare();
        banner(`ROUND ${s.round} — PERFECT!`, '#7dff9b', 1.8);
      } else {
        banner(`ROUND ${s.round} — ${crushed} LOST`, '#ffb45c', 1.8);
      }
      if (s.npcs.some((n) => n[3] === NPC_SAVED)) sfx.fanfare();
    }

    // Last-seconds ticks.
    if (s.phase === 'play' && s.roundPhase === 'form') {
      const left = Math.max(0, s.timeLimit - elapsed);
      const sec = Math.ceil(left);
      if (left <= DANGER_AT && sec !== lastTickSecond && sec > 0) {
        lastTickSecond = sec;
        sfx.tick(sec <= 1);
      }
    }

    // Camera: fixed, with a thump on landing.
    camera.position.copy(camCenter).addScaledVector(ISO_DIR, 60);
    if (clockT < shakeUntil) {
      const k = (shakeUntil - clockT) / 0.35;
      camera.position.x += (Math.random() - 0.5) * 0.5 * k;
      camera.position.y += (Math.random() - 0.5) * 0.5 * k;
    }
    camera.lookAt(camCenter);
    renderer.render(scene, camera);
    drawOverlay(s, w, h, dpr, elapsed);
  }

  function updateWall(s: TetrisSnapshot, elapsed: number) {
    if (!wallGroup || !wallMat || !dangerMat || !tileMat) return;
    let y = HOVER_Y;
    let opacity = 0.16;
    let dangerOp = 0;
    if (s.roundPhase === 'form') {
      const left = Math.max(0, s.timeLimit - elapsed);
      const urgency = left <= DANGER_AT ? 1 - left / DANGER_AT : 0;
      y = HOVER_Y + Math.sin(clockT * 1.3) * 0.15 - urgency * 0.6;
      opacity = 0.16 + urgency * 0.2 + (urgency > 0 ? Math.abs(Math.sin(clockT * 10)) * 0.08 : 0);
      dangerOp = urgency * 0.3;
      tileMat.opacity = 0.3 + Math.abs(Math.sin(clockT * 2.2)) * 0.12;
      wallGroup.rotation.y = 0;
    } else if (s.roundPhase === 'drop') {
      const p = Math.min(1, elapsed / DROP_DUR);
      y = HOVER_Y * (1 - p * p);
      opacity = 0.16 + p * 0.8;
      dangerOp = 0.3 * (1 - p);
      tileMat.opacity = 0.42;
    } else if (s.roundPhase === 'rest') {
      y = 0;
      opacity = 0.92;
      tileMat.opacity = 0.42;
    } else {
      const p = Math.min(1, elapsed / RISE_DUR);
      const e = 1 - (1 - p) * (1 - p);
      y = RISE_Y * e;
      opacity = 0.92 * (1 - Math.max(0, (p - 0.55) / 0.45));
      tileMat.opacity = 0.42 * (1 - p);
    }
    if (s.phase === 'over') {
      y = 0;
      opacity = 0.92;
    }
    wallGroup.position.y = y;
    wallMat.opacity = opacity;
    dangerMat.opacity = dangerOp;
  }

  function updateActors(s: TetrisSnapshot, dt: number) {
    const k = 1 - Math.exp(-16 * dt);
    for (const av of avatars.values()) {
      const g = av.parts.group;
      const nx = av.x + (av.tx - av.x) * k;
      const nz = av.z + (av.tz - av.z) * k;
      av.vx = (nx - av.x) / Math.max(dt, 1e-3);
      av.vz = (nz - av.z) / Math.max(dt, 1e-3);
      av.x = nx;
      av.z = nz;
      if (av.state === TETRIS_OUT && clockT >= av.outAt) {
        const since = clockT - av.outAt;
        if (since < dt * 2) grayOut(av.parts);
        g.position.set(av.x, 0, av.z);
        g.rotation.set(0, 0, 0);
        squashMotion(g, since);
        continue;
      }
      const speed = Math.hypot(av.vx, av.vz);
      av.bob += dt * (3 + speed * 4);
      let hop = 0;
      if (clockT < av.pingUntil) {
        // "Find me": a couple of eager jumps.
        const p = (1.6 - (av.pingUntil - clockT)) / 1.6;
        hop = Math.abs(Math.sin(p * Math.PI * 3)) * 0.45;
      }
      g.position.set(av.x, hop, av.z);
      g.scale.set(1, 1, 1);
      // Lean into the run.
      g.rotation.z += (-av.vx * 0.05 - g.rotation.z) * k;
      g.rotation.x += (av.vz * 0.05 - g.rotation.x) * k;
      av.parts.body.position.y = 0.42 + Math.sin(av.bob) * (0.015 + speed * 0.006);
    }
    for (const n of npcs.values()) {
      const g = n.parts.group;
      if (n.attachedTo !== 0) {
        // Riding on shoulders; a saved rider celebrates after the landing.
        if (n.state === NPC_SAVED && clockT >= n.doneAt) {
          const p = Math.min(1, (clockT - n.doneAt) / 1.3);
          g.position.y = AVATAR_TOP + p * 2.2;
          g.rotation.y += dt * 9;
          g.scale.setScalar(0.72 * (1 - p));
          g.visible = p < 1;
        } else {
          n.bob += dt * 3;
          g.position.y = AVATAR_TOP - 0.02 + Math.sin(n.bob) * 0.02;
        }
        continue;
      }
      n.x += (n.tx - n.x) * k;
      n.z += (n.tz - n.z) * k;
      if (n.state === NPC_CRUSHED && clockT >= n.doneAt) {
        const since = clockT - n.doneAt;
        if (since < dt * 2) grayOut(n.parts);
        g.position.set(n.x, 0, n.z);
        squashMotion(g, since);
        continue;
      }
      if (n.state === NPC_SAVED && clockT >= n.doneAt) {
        const p = Math.min(1, (clockT - n.doneAt) / 1.3);
        g.position.set(n.x, p * 2.2, n.z);
        g.rotation.y += dt * 9;
        g.scale.setScalar(0.9 * (1 - p));
        g.visible = p < 1;
        continue;
      }
      // Waiting: a hopeful little hop so the crowd spots them.
      n.bob += dt * 4;
      g.position.set(n.x, Math.max(0, Math.sin(n.bob)) * 0.18, n.z);
      g.scale.setScalar(0.9);
    }
  }

  // ------------------------------------------------------------ overlay
  const proj = new THREE.Vector3();

  function drawOverlay(s: TetrisSnapshot, w: number, h: number, dpr: number, elapsed: number) {
    if (!overlay || !camera) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Fixed-size labels over every figure — never shrink with the camera.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const worldPos = new THREE.Vector3();
    for (const av of avatars.values()) {
      const g = av.parts.group;
      if (!g.visible) continue;
      const squashed = av.state === TETRIS_OUT && clockT >= av.outAt;
      const top = squashed ? 0.25 : av.carrying ? AVATAR_TOP + 0.95 : AVATAR_TOP + 0.2;
      proj.set(av.x, top + g.position.y, av.z).project(camera);
      if (proj.z > 1) continue;
      const px = ((proj.x + 1) / 2) * w;
      const py = ((1 - proj.y) / 2) * h - (av.slot % 3) * 3;
      const pinged = clockT < av.pingUntil;
      const size = pinged ? 30 : 14;
      const label = String(av.slot).padStart(2, '0');
      ctx.font = `800 ${size}px system-ui`;
      if (pinged) {
        ctx.fillStyle = av.color;
        const tw = ctx.measureText(label).width;
        ctx.beginPath();
        ctx.roundRect(px - tw / 2 - 7, py - size - 8, tw + 14, size + 12, 8);
        ctx.fill();
      }
      ctx.lineWidth = pinged ? 5 : 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, px, py);
      ctx.fillStyle = squashed ? '#9a9aa6' : '#ffffff';
      ctx.fillText(label, px, py);
    }
    for (const n of npcs.values()) {
      if (n.state !== NPC_WAITING || !n.parts.group.visible) continue;
      n.parts.group.getWorldPosition(worldPos);
      proj.set(worldPos.x, worldPos.y + AVATAR_TOP + 0.45, worldPos.z).project(camera);
      if (proj.z > 1) continue;
      const px = ((proj.x + 1) / 2) * w;
      const py = ((1 - proj.y) / 2) * h - Math.abs(Math.sin(clockT * 4)) * 6;
      ctx.font = `800 13px system-ui`;
      ctx.fillStyle = '#ffe066';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.strokeText('HELP!', px, py);
      ctx.fillText('HELP!', px, py);
    }

    drawHud(ctx, s, w, h, elapsed);
  }

  function drawHud(ctx: CanvasRenderingContext2D, s: TetrisSnapshot, w: number, h: number, elapsed: number) {
    const room = getRoom();
    ctx.textBaseline = 'top';

    // Round + timer, top-left.
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(h * 0.04)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    if (s.round > 0) ctx.fillText(`ROUND ${s.round}`, h * 0.03, h * 0.025);
    if (s.phase === 'play' && s.roundPhase === 'form') {
      const left = Math.max(0, s.timeLimit - elapsed);
      const urgent = left <= DANGER_AT;
      ctx.font = `800 ${Math.round(h * 0.055)}px system-ui`;
      ctx.fillStyle = urgent ? '#ff7b8a' : 'rgba(255,255,255,0.9)';
      ctx.fillText(`⏱ ${left.toFixed(1)}`, h * 0.03, h * 0.075);
      // Timer bar.
      const bw = w * 0.22;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.roundRect(h * 0.03, h * 0.145, bw, h * 0.014, 6);
      ctx.fill();
      ctx.fillStyle = urgent ? '#ff5964' : '#5cff9b';
      ctx.beginPath();
      ctx.roundRect(h * 0.03, h * 0.145, bw * (left / s.timeLimit), h * 0.014, 6);
      ctx.fill();
    } else if (s.phase === 'play') {
      ctx.font = `800 ${Math.round(h * 0.05)}px system-ui`;
      ctx.fillStyle = '#b9c0e0';
      ctx.fillText(
        s.roundPhase === 'drop' ? '⬇ THE WALL' : s.roundPhase === 'rest' ? '…' : '⬆ get ready',
        h * 0.03,
        h * 0.075,
      );
    }

    // Tallies, top-right: lives, rescued, alive, cleared.
    const lives = Math.max(0, s.lossBudget - s.losses);
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(h * 0.034)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    const hearts = lives <= 12 ? '❤️'.repeat(lives) + '🖤'.repeat(Math.min(12, s.lossBudget) - lives) : `❤️ × ${lives}`;
    ctx.fillText(hearts, w - h * 0.03, h * 0.025);
    ctx.font = `700 ${Math.round(h * 0.03)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(
      `🧍 ${s.aliveCount}   🙋 ${s.rescued} rescued   🏆 ${s.cleared} cleared`,
      w - h * 0.03,
      h * 0.075,
    );

    // Big countdown digits in the last seconds.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (s.phase === 'play' && s.roundPhase === 'form') {
      const left = Math.max(0, s.timeLimit - elapsed);
      if (left <= DANGER_AT) {
        const sec = Math.ceil(left);
        const frac = 1 - (sec - left); // 0 → 1 within this second
        ctx.globalAlpha = 0.35 + 0.65 * (1 - frac);
        ctx.font = `800 ${Math.round(h * (0.18 + frac * 0.04))}px system-ui`;
        ctx.fillStyle = '#ff5964';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 8;
        ctx.strokeText(String(sec), w / 2, h * 0.18);
        ctx.fillText(String(sec), w / 2, h * 0.18);
        ctx.globalAlpha = 1;
      }
    }

    // Banner.
    if (clockT < bannerUntil && s.phase !== 'countdown') {
      const p = Math.min(1, (bannerUntil - clockT) / 0.4);
      ctx.globalAlpha = p;
      ctx.font = `800 ${Math.round(h * 0.06)}px system-ui`;
      ctx.fillStyle = bannerColor;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 6;
      ctx.strokeText(bannerText, w / 2, h * 0.12);
      ctx.fillText(bannerText, w / 2, h * 0.12);
      ctx.globalAlpha = 1;
    }

    // Crushed numbers while the wall rests.
    if (s.phase !== 'countdown' && s.roundPhase === 'rest' && s.lastCrushed[0].length > 0) {
      ctx.font = `700 ${Math.round(h * 0.034)}px system-ui`;
      ctx.fillStyle = '#ffb4bb';
      const nums = s.lastCrushed[0].map((n) => `#${String(n).padStart(2, '0')}`).join('  ');
      ctx.fillText(`flattened: ${nums}`, w / 2, h * 0.2);
    }

    if (s.phase === 'countdown' && s.countdown > 0) {
      ctx.font = `800 ${Math.round(h * 0.26)}px system-ui`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(String(s.countdown), w / 2, h / 2);
      ctx.font = `700 ${Math.round(h * 0.035)}px system-ui`;
      ctx.fillText(
        'Get everyone INSIDE the shape before the wall drops — and carry the lost ones in with you!',
        w / 2,
        h * 0.8,
      );
    } else if (s.phase === 'over') {
      ctx.fillStyle = 'rgba(10,12,24,0.85)';
      const pw = w * 0.5;
      const ph = h * 0.5;
      ctx.beginPath();
      ctx.roundRect((w - pw) / 2, (h - ph) / 2, pw, ph, 22);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = `800 ${Math.round(h * 0.055)}px system-ui`;
      ctx.fillText('HUMAN TETRIS', w / 2, h / 2 - ph * 0.36);
      ctx.font = `800 ${Math.round(h * 0.09)}px system-ui`;
      ctx.fillStyle = '#ffe066';
      ctx.fillText(`${s.cleared} round${s.cleared === 1 ? '' : 's'} cleared`, w / 2, h / 2 - ph * 0.1);
      ctx.font = `700 ${Math.round(h * 0.032)}px system-ui`;
      ctx.fillStyle = '#b9c0e0';
      const flat = s.players.filter((p) => p[3] === TETRIS_OUT).length;
      ctx.fillText(
        `${s.aliveCount} still standing · ${flat} flattened · ${s.rescued} rescued`,
        w / 2,
        h / 2 + ph * 0.16,
      );
      const crushedNames = s.lastCrushed[0]
        .slice(0, 6)
        .map((slot) => `#${String(slot).padStart(2, '0')} ${room?.players.find((p) => p.id === slot)?.name ?? ''}`)
        .join(', ');
      if (crushedNames) {
        ctx.font = `700 ${Math.round(h * 0.028)}px system-ui`;
        ctx.fillStyle = '#ffb4bb';
        ctx.fillText(`the last wall took ${crushedNames}`, w / 2, h / 2 + ph * 0.32);
      }
    }
  }

  function dispose() {
    renderer?.dispose();
    if (container) container.innerHTML = '';
    scene = null;
    renderer = null;
    overlay = null;
    camera = null;
    avatars.clear();
    npcs.clear();
    oneShots.length = 0;
    built = false;
  }

  return { mount, push, frame, dispose };
}
