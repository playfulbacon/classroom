// Medusa stage renderer: isometric three.js scene (code-split — only the
// stage loads this chunk, and only when a Medusa round starts).
//
// World axes: x = race axis (left → right, Medusa at high x), z = lanes
// (screen depth), y = up. One grid cell = 1 world unit.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type {
  MedusaGazeState,
  MedusaSnapshot,
  RoomState,
} from '../../../shared/protocol';
import * as sfx from '../sfx';

const HOP_DUR = 0.2;
const TURN_TIME = 0.8;

const ST_RUN = 0;
const ST_STONE = 1;
const ST_FINISHED = 2;
const ST_FALLEN = 3;

interface Avatar {
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
  state: number;
  stoneAt: number;
  fallAt: number;
  bobPhase: number;
  pingUntil: number;
}

interface OneShot {
  mesh: THREE.Object3D;
  start: number;
  dur: number;
  update: (p: number) => void;
}

// Player colors use modern space-separated hsl() syntax, which THREE.Color
// cannot parse — convert explicitly.
function parseColor(css: string): THREE.Color {
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

function subCellOffset(slot: number): [number, number] {
  // Deterministic scatter inside a cell so piled players read as a cluster.
  const a = ((slot * 2654435761) >>> 0) / 4294967296;
  const b = ((slot * 40503 + 12345) >>> 0 & 0xffff) / 65536;
  return [(a - 0.5) * 0.56, (b - 0.5) * 0.56];
}

export interface MedusaRenderer3D {
  mount(container: HTMLElement): void;
  push(snap: MedusaSnapshot): void;
  frame(): void;
  dispose(): void;
}

export function createMedusaRenderer(
  getRoom: () => RoomState | null,
): MedusaRenderer3D {
  let container: HTMLElement | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let overlay: HTMLCanvasElement | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;

  let snap: MedusaSnapshot | null = null;
  let built = false;
  const avatars = new Map<number, Avatar>();
  const oneShots: OneShot[] = [];
  let headGroup: THREE.Group | null = null;
  let headSpin: THREE.Group | null = null; // rotates for gaze
  let eyeMats: THREE.MeshLambertMaterial[] = [];
  let redLight: THREE.PointLight | null = null;

  let lastNow = 0;
  let clockT = 0; // renderer-local seconds
  let lastGaze: MedusaGazeState | 'none' = 'none';
  let lastPhase = '';
  let redFade = 0; // 0..1 vignette amount
  let finishedSeen = 0;

  // damped camera state
  const camCenter = new THREE.Vector3(2, 0, 8);
  let camHalfW = 12;

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8d8d99 });
  const stoneDark = new THREE.MeshLambertMaterial({ color: 0x6f6f7a });

  function fieldCenterZ(): number {
    return snap ? (snap.lanes - 1) / 2 : 8;
  }

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
    scene.background = new THREE.Color(0x10142a);
    scene.fog = new THREE.Fog(0x10142a, 55, 110);
    camera = new THREE.OrthographicCamera(-12, 12, 7, -7, 0.1, 300);
    addLights();
  }

  function addLights() {
    if (!scene) return;
    scene.add(new THREE.HemisphereLight(0xbcc7ff, 0x2a2f45, 0.95));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    sun.position.set(-18, 30, 14);
    scene.add(sun);
  }

  // A replay starts a fresh round (new pits, everyone back at the start):
  // tear the scene down and rebuild from the next snapshot.
  function resetRound() {
    if (!scene) return;
    scene.clear();
    addLights();
    avatars.clear();
    oneShots.length = 0;
    headGroup = null;
    headSpin = null;
    redLight = null;
    eyeMats = [];
    built = false;
    finishedSeen = 0;
    lastGaze = 'none';
    redFade = 0;
  }

  // ---------------------------------------------------------------- field
  function buildField(s: MedusaSnapshot) {
    if (!scene) return;
    const L = s.length;
    const lanes = s.lanes;
    const cz = (lanes - 1) / 2;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(L + 14, lanes + 10),
      new THREE.MeshLambertMaterial({ color: 0x2e4a3a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(L / 2 + 1, -0.02, cz);
    scene.add(ground);

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
    scene.add(grid);

    // Start zone tint + finish strip.
    const startZone = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, lanes),
      new THREE.MeshLambertMaterial({ color: 0x3a5d8a, transparent: true, opacity: 0.5 }),
    );
    startZone.rotation.x = -Math.PI / 2;
    startZone.position.set(0.55, 0.001, cz);
    scene.add(startZone);
    const finish = new THREE.Mesh(
      new THREE.PlaneGeometry(1, lanes),
      new THREE.MeshLambertMaterial({ color: 0xd8b64a, transparent: true, opacity: 0.85 }),
    );
    finish.rotation.x = -Math.PI / 2;
    finish.position.set(L - 1, 0.002, cz);
    scene.add(finish);

    // Pits: dark recessed squares with a rim.
    const pitTop = new THREE.MeshLambertMaterial({ color: 0x05060d });
    const pitRim = new THREE.MeshLambertMaterial({ color: 0x1b2438 });
    for (const [col, lane] of s.pits) {
      const rim = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), pitRim);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(col, 0.004, lane);
      scene.add(rim);
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.78), pitTop);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(col, 0.006, lane);
      scene.add(hole);
    }

    buildMedusaHead(L, cz);
  }

  // ------------------------------------------------------------- Medusa
  function buildMedusaHead(L: number, cz: number) {
    if (!scene) return;
    headGroup = new THREE.Group();
    headGroup.position.set(L + 1.6, 0, cz);
    scene.add(headGroup);

    // Pedestal (always procedural).
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.9, 1.2, 8),
      new THREE.MeshLambertMaterial({ color: 0x555a6e }),
    );
    pedestal.position.y = 0.6;
    headGroup.add(pedestal);

    headSpin = new THREE.Group();
    headSpin.position.y = 2.6;
    headSpin.rotation.y = Math.PI; // start facing away (green)
    headGroup.add(headSpin);

    const loader = new GLTFLoader();
    loader.load(
      '/models/medusa.glb',
      (gltf) => {
        if (!headSpin) return;
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = 3 / Math.max(size.y, 0.001);
        model.scale.setScalar(scale);
        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        // Convention: the model faces +Z; rotate so +Z looks down the field.
        const wrap = new THREE.Group();
        wrap.rotation.y = -Math.PI / 2;
        wrap.add(model);
        headSpin.clear();
        headSpin.add(wrap);
        addEyesLight();
      },
      undefined,
      () => buildProceduralHead(),
    );
    buildProceduralHead();
  }

  function buildProceduralHead() {
    if (!headSpin) return;
    headSpin.clear();
    eyeMats = [];
    const g = new THREE.Group();
    const skin = new THREE.MeshLambertMaterial({ color: 0x5f8a4e });
    const face = new THREE.Mesh(new THREE.SphereGeometry(1.15, 20, 16), skin);
    g.add(face);
    // Snake "hair": cones splayed over the crown.
    const snakeMat = new THREE.MeshLambertMaterial({ color: 0x3f6b3a });
    const headTip = new THREE.MeshLambertMaterial({ color: 0x89c46b });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tilt = 0.5 + (i % 3) * 0.25;
      const snake = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.1, 6), snakeMat);
      body.position.y = 0.55;
      snake.add(body);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), headTip);
      tip.position.y = 1.12;
      snake.add(tip);
      snake.position.set(Math.cos(a) * 0.62, 0.72, Math.sin(a) * 0.62);
      snake.rotation.z = Math.cos(a) * tilt;
      snake.rotation.x = -Math.sin(a) * tilt;
      g.add(snake);
    }
    // Eyes on the -x side (facing the field when headSpin.rotation.y === 0).
    for (const dz of [-0.42, 0.42]) {
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        emissive: 0x220000,
      });
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat);
      eye.position.set(-1.0, 0.18, dz);
      g.add(eye);
      eyeMats.push(mat);
    }
    // Mouth.
    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.08, 0.55),
      new THREE.MeshLambertMaterial({ color: 0x24401f }),
    );
    mouth.position.set(-1.08, -0.45, 0);
    g.add(mouth);
    headSpin.add(g);
    addEyesLight();
  }

  function addEyesLight() {
    if (!headSpin || redLight) return;
    redLight = new THREE.PointLight(0xff2233, 0, 30);
    redLight.position.set(-1.6, 0, 0);
    headSpin.add(redLight);
  }

  // ------------------------------------------------------------- avatars
  function makeAvatar(slot: number, color: string): Avatar {
    const group = new THREE.Group();
    const base = parseColor(color);
    const bodyMat = new THREE.MeshLambertMaterial({ color: base });
    const headMat = new THREE.MeshLambertMaterial({
      color: base.clone().lerp(new THREE.Color('#ffffff'), 0.35),
    });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.3, 3, 8), bodyMat);
    body.position.y = 0.42;
    body.name = 'body';
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), headMat);
    head.position.y = 0.84;
    head.name = 'head';
    group.add(head);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    group.add(shadow);
    scene?.add(group);
    return {
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
      state: ST_RUN,
      stoneAt: 0,
      fallAt: 0,
      bobPhase: (slot % 17) * 0.4,
      pingUntil: 0,
    };
  }

  function turnToStone(av: Avatar) {
    av.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.name === 'body') mesh.material = stoneMat;
      if (mesh.isMesh && mesh.name === 'head') mesh.material = stoneDark;
    });
  }

  function spawnRing(x: number, z: number, color: string) {
    if (!scene) return;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 24),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.03, z);
    scene.add(mesh);
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

  function spawnDust(x: number, z: number) {
    if (!scene) return;
    for (let i = 0; i < 6; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0x9a917f, transparent: true, opacity: 0.8 }),
      );
      const a = Math.random() * Math.PI * 2;
      const r = 0.15 + Math.random() * 0.25;
      puff.position.set(x, 0.1, z);
      scene.add(puff);
      const vx = Math.cos(a) * r;
      const vz = Math.sin(a) * r;
      oneShots.push({
        mesh: puff,
        start: clockT,
        dur: 0.7,
        update: (p) => {
          puff.position.set(x + vx * p * 2, 0.1 + p * 0.5 - p * p * 0.4, z + vz * p * 2);
          puff.scale.setScalar(1 + p);
          (puff.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - p);
        },
      });
    }
  }

  // --------------------------------------------------------------- push
  function push(s: MedusaSnapshot) {
    if (s.phase === 'countdown' && lastPhase === 'over') resetRound();
    const room = getRoom();
    const colors = new Map<number, string>();
    if (room) for (const p of room.players) colors.set(p.id, p.color);

    if (!built && scene) {
      buildField(s);
      built = true;
      // Initialize avatars at their cells without hop animation.
      for (const [slot, col, lane] of s.players) {
        const av = makeAvatar(slot, colors.get(slot) ?? '#999');
        const [ox, oz] = subCellOffset(slot);
        av.x = av.tx = av.fromX = col + ox;
        av.z = av.tz = av.fromZ = lane + oz;
        avatars.set(slot, av);
      }
      camCenter.set(1, 0, fieldCenterZ());
    }

    // Gaze transitions → sfx.
    if (s.gaze.state !== lastGaze) {
      if (lastGaze !== 'none' && s.phase === 'play') {
        if (s.gaze.state === 'turning') sfx.warning();
        else if (s.gaze.state === 'red') sfx.red();
        else if (s.gaze.state === 'green') sfx.green();
      }
      lastGaze = s.gaze.state;
    }
    if (s.phase !== lastPhase) {
      if (s.phase === 'play') sfx.green();
      if (s.phase === 'over') sfx.gong();
      lastPhase = s.phase;
    }
    if (s.finished.length > finishedSeen) {
      sfx.fanfare();
      finishedSeen = s.finished.length;
    }

    for (const [slot, col, lane, state] of s.players) {
      let av = avatars.get(slot);
      if (!av) {
        av = makeAvatar(slot, colors.get(slot) ?? '#999');
        const [ox, oz] = subCellOffset(slot);
        av.x = av.tx = col + ox;
        av.z = av.tz = lane + oz;
        avatars.set(slot, av);
      }
      const [ox, oz] = subCellOffset(slot);
      let tx = col + ox;
      let tz = lane + oz;
      if (state === ST_FINISHED && s.length) {
        // Celebrate past the finish line, fanned out beside Medusa.
        const rank = Math.max(0, s.finished.indexOf(slot));
        tx = s.length + 0.2 + (rank % 3) * 0.55;
        tz = fieldCenterZ() + (rank % 2 === 0 ? 1 : -1) * (1.5 + Math.floor(rank / 6));
      }
      if (Math.abs(tx - av.tx) > 0.001 || Math.abs(tz - av.tz) > 0.001) {
        av.fromX = av.x;
        av.fromZ = av.z;
        av.tx = tx;
        av.tz = tz;
        av.hopStart = clockT;
      }
      if (state !== av.state) {
        if (state === ST_STONE) {
          av.stoneAt = clockT;
          turnToStone(av);
          sfx.crack();
        } else if (state === ST_FALLEN) {
          av.fallAt = clockT;
          sfx.fall();
          spawnDust(av.x, av.z);
        }
        av.state = state;
      }
    }
    for (const slot of s.pings) {
      const av = avatars.get(slot);
      if (av) {
        av.pingUntil = clockT + 2;
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

    // Resize.
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
    }

    updateAvatars(dt);
    updateHead(dt);
    updateOneShots();
    updateCamera(s, w / h, dt);

    renderer.render(scene, camera);
    drawOverlay(s, w, h, dpr);
  }

  function updateAvatars(dt: number) {
    for (const av of avatars.values()) {
      // Hop interpolation.
      if (av.hopStart >= 0) {
        const p = Math.min(1, (clockT - av.hopStart) / HOP_DUR);
        av.x = av.fromX + (av.tx - av.fromX) * p;
        av.z = av.fromZ + (av.tz - av.fromZ) * p;
        const hopY = Math.sin(p * Math.PI) * 0.32;
        av.group.position.set(av.x, hopY, av.z);
        // Squash on landing.
        const squash = p > 0.85 ? 1 - (1 - (1 - p) / 0.15) * 0.15 : 1;
        av.group.scale.set(1 / squash, squash, 1 / squash);
        if (p >= 1) av.hopStart = -1;
      } else {
        av.group.position.set(av.x, 0, av.z);
        av.group.scale.set(1, 1, 1);
      }

      if (av.state === ST_RUN) {
        // Idle bob.
        av.bobPhase += dt * 3;
        const body = av.group.getObjectByName('body');
        if (body) body.position.y = 0.42 + Math.sin(av.bobPhase) * 0.015;
      } else if (av.state === ST_STONE) {
        const since = clockT - av.stoneAt;
        if (since < 0.25) {
          av.group.rotation.z = Math.sin(since * 60) * 0.06 * (1 - since / 0.25);
        } else {
          av.group.rotation.z = 0;
        }
      } else if (av.state === ST_FALLEN) {
        const p = Math.min(1, (clockT - av.fallAt) / 0.45);
        av.group.position.y = -1.4 * p * p;
        av.group.rotation.x = p * 1.2;
        av.group.visible = p < 1;
      }
    }
  }

  function updateHead(dt: number) {
    if (!headSpin || !snap) return;
    // Target yaw: PI = facing away (green), 0 = facing the field (red).
    const g = snap.gaze;
    let target: number;
    if (g.state === 'green') target = Math.PI;
    else if (g.state === 'red') target = 0;
    else if (g.state === 'turning') target = Math.PI * (g.tLeft / TURN_TIME);
    else target = Math.PI * (1 - g.tLeft / TURN_TIME);
    const k = 1 - Math.exp(-14 * dt);
    headSpin.rotation.y += (target - headSpin.rotation.y) * k;

    const red = g.state === 'red' && snap.phase === 'play';
    redFade += ((red ? 1 : 0) - redFade) * (1 - Math.exp(-8 * dt));
    for (const m of eyeMats) {
      m.emissive.setRGB(0.25 + redFade * 0.75, 0.02, 0.02);
    }
    if (redLight) redLight.intensity = redFade * 3.2;
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

  function updateCamera(s: MedusaSnapshot, aspect: number, dt: number) {
    if (!camera) return;
    // Bounds of everyone still on the field (statues included — they're the
    // story), plus a peek ahead of the leaders.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const av of avatars.values()) {
      if (av.state === ST_FALLEN) continue;
      minX = Math.min(minX, av.x);
      maxX = Math.max(maxX, av.x);
      minZ = Math.min(minZ, av.z);
      maxZ = Math.max(maxZ, av.z);
    }
    if (minX === Infinity) {
      minX = 0;
      maxX = s.length;
      minZ = 0;
      maxZ = s.lanes;
    }
    maxX += 3.2; // look ahead toward Medusa
    minX -= 1.2;
    minZ -= 1.5;
    maxZ += 1.5;

    let cx = (minX + maxX) / 2;
    let cz = (minZ + maxZ) / 2;

    // Intro sweep during the countdown: from Medusa back to the start.
    if (s.phase === 'countdown' && headGroup) {
      const p = Math.min(1, Math.max(0, 1 - s.countdown / 3));
      const ease = p * p * (3 - 2 * p);
      cx = headGroup.position.x + (cx - headGroup.position.x) * ease;
      cz = fieldCenterZ() + (cz - fieldCenterZ()) * ease;
    }

    const dir = new THREE.Vector3(-0.62, 0.85, 1).normalize();
    const center = new THREE.Vector3(cx, 0.5, cz);
    const k = 1 - Math.exp(-3.2 * dt);
    camCenter.lerp(center, k);

    // Fit the ortho frustum to the bounds at this iso angle.
    camera.position.copy(camCenter).addScaledVector(dir, 60);
    camera.lookAt(camCenter);
    camera.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(camera.matrixWorldInverse);
    let needW = 6;
    let needH = 4;
    const v = new THREE.Vector3();
    for (const px of [minX, maxX]) {
      for (const pz of [minZ, maxZ]) {
        for (const py of [0, 2.2]) {
          v.set(px, py, pz).applyMatrix4(inv);
          needW = Math.max(needW, Math.abs(v.x - 0));
          needH = Math.max(needH, Math.abs(v.y - 0));
        }
      }
    }
    let halfW = Math.max(needW, needH * aspect) * 1.12;
    if (redFade > 0.02) halfW *= 1 - redFade * 0.04; // subtle push-in on red
    camHalfW += (halfW - camHalfW) * k;
    camera.left = -camHalfW;
    camera.right = camHalfW;
    camera.top = camHalfW / aspect;
    camera.bottom = -camHalfW / aspect;
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- overlay
  const proj = new THREE.Vector3();

  function drawOverlay(s: MedusaSnapshot, w: number, h: number, dpr: number) {
    if (!overlay || !camera) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Red vignette while she watches.
    if (redFade > 0.02) {
      const grad = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.35,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.72,
      );
      grad.addColorStop(0, 'rgba(255,30,40,0)');
      grad.addColorStop(1, `rgba(255,20,35,${0.3 * redFade})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // Fixed-size number labels (the key legibility feature: they never
    // shrink when the camera zooms out).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const [slot] of avatars) {
      const av = avatars.get(slot)!;
      if (av.state === ST_FALLEN) continue;
      proj.set(av.x, 1.15 + av.group.position.y, av.z).project(camera);
      if (proj.z > 1) continue;
      const px = ((proj.x + 1) / 2) * w;
      const py = ((1 - proj.y) / 2) * h - (slot % 3) * 4;
      const pinged = clockT < av.pingUntil;
      const size = pinged ? 30 : 14;
      const label = String(slot).padStart(2, '0');
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
      ctx.fillStyle = av.state === ST_STONE ? '#b9b9c4' : '#ffffff';
      ctx.fillText(label, px, py);
    }

    drawHud(ctx, s, w, h);
  }

  function drawHud(
    ctx: CanvasRenderingContext2D,
    s: MedusaSnapshot,
    w: number,
    h: number,
  ) {
    const room = getRoom();
    ctx.textBaseline = 'top';

    // Timer.
    const left = Math.max(0, s.timeLimit - s.t);
    const mm = Math.floor(left / 60);
    const ss = String(Math.floor(left % 60)).padStart(2, '0');
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(h * 0.045)}px system-ui`;
    ctx.fillStyle = left < 15 ? '#ff7b8a' : 'rgba(255,255,255,0.9)';
    ctx.fillText(`⏱ ${mm}:${ss}`, h * 0.03, h * 0.025);

    // Tallies.
    const stones = s.players.filter((p) => p[3] === ST_STONE).length;
    const fell = s.players.filter((p) => p[3] === ST_FALLEN).length;
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(h * 0.03)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(
      `🏃 ${s.aliveCount}   🏁 ${s.finished.length}   🗿 ${stones}   🕳 ${fell}`,
      w - h * 0.03,
      h * 0.03,
    );

    // Gaze banner.
    if (s.phase === 'play') {
      const g = s.gaze.state;
      const label =
        g === 'green'
          ? 'GO!'
          : g === 'turning'
            ? '⚠ SHE’S TURNING…'
            : g === 'red'
              ? 'DON’T MOVE'
              : '…she looks away…';
      const color =
        g === 'green'
          ? '#7dff9b'
          : g === 'turning'
            ? '#ffe066'
            : g === 'red'
              ? '#ff5964'
              : '#b9c0e0';
      const pulse = g === 'turning' ? 0.6 + 0.4 * Math.abs(Math.sin(clockT * 8)) : 1;
      ctx.globalAlpha = pulse;
      ctx.textAlign = 'center';
      ctx.font = `800 ${Math.round(h * 0.055)}px system-ui`;
      ctx.fillStyle = color;
      ctx.fillText(label, w / 2, h * 0.02);
      ctx.globalAlpha = 1;
    }

    // Countdown / results.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (s.phase === 'countdown' && s.countdown > 0) {
      ctx.font = `800 ${Math.round(h * 0.26)}px system-ui`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(String(s.countdown), w / 2, h / 2);
      ctx.font = `700 ${Math.round(h * 0.035)}px system-ui`;
      ctx.fillText('Reach Medusa before time runs out — freeze when she turns!', w / 2, h * 0.8);
    } else if (s.phase === 'over') {
      ctx.fillStyle = 'rgba(10,12,24,0.85)';
      const pw = w * 0.46;
      const ph = h * 0.56;
      ctx.beginPath();
      ctx.roundRect((w - pw) / 2, (h - ph) / 2, pw, ph, 22);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = `800 ${Math.round(h * 0.055)}px system-ui`;
      ctx.fillText('MEDUSA', w / 2, h / 2 - ph * 0.4);
      const names = new Map<number, string>();
      if (room) for (const p of room.players) names.set(p.id, p.name);
      const medals = ['🥇', '🥈', '🥉'];
      const top = s.finished.slice(0, 5);
      if (top.length === 0) {
        ctx.font = `700 ${Math.round(h * 0.04)}px system-ui`;
        ctx.fillText('Nobody made it… the garden grows. 🗿', w / 2, h / 2 - ph * 0.1);
      }
      top.forEach((slot, i) => {
        ctx.font = `700 ${Math.round(h * 0.042)}px system-ui`;
        ctx.fillText(
          `${medals[i] ?? `${i + 1}.`} #${String(slot).padStart(2, '0')} ${names.get(slot) ?? ''}`,
          w / 2,
          h / 2 - ph * 0.22 + i * h * 0.07,
        );
      });
      const stones2 = s.players.filter((p) => p[3] === ST_STONE).length;
      const fell2 = s.players.filter((p) => p[3] === ST_FALLEN).length;
      ctx.font = `700 ${Math.round(h * 0.032)}px system-ui`;
      ctx.fillStyle = '#b9c0e0';
      ctx.fillText(
        `${s.finished.length} escaped · ${stones2} statues · ${fell2} in the pits`,
        w / 2,
        h / 2 + ph * 0.4,
      );
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
    oneShots.length = 0;
    built = false;
  }

  return { mount, push, frame, dispose };
}
