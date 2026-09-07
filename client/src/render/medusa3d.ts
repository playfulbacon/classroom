// Medusa stage renderer: isometric three.js scene (code-split — only the
// stage loads this chunk, and only when a Medusa round starts). The scene
// art itself (field, obstacles, avatars, motion) lives in medusaScene.ts.
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
import {
  ISO_DIR,
  HOP_DUR,
  SCENE_BG,
  ST_FALLEN,
  ST_FINISHED,
  ST_RUN,
  ST_STONE,
  FERRY_TOP,
  addLights,
  applyTier,
  buildField,
  layoutFromSnapshot,
  makeAvatar,
  setBlindfold,
  styleCrumble,
  subCellOffset,
  turnToStone,
  updateAvatarMotion,
  ferryMeshFor,
  followFerry,
  lerpPlatforms,
  type Avatar,
  type FieldHandles,
} from './medusaScene';

const TURN_TIME = 0.8;

interface OneShot {
  mesh: THREE.Object3D;
  start: number;
  dur: number;
  update: (p: number) => void;
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
  // The v2 red-light cut: a second camera framed on Medusa's face, with the
  // field and every runner hidden — the projector must leak NO positions.
  let faceCam: THREE.PerspectiveCamera | null = null;
  let fieldRoot: THREE.Group | null = null;
  let actorsRoot: THREE.Group | null = null;

  let snap: MedusaSnapshot | null = null;
  let built = false;
  const avatars = new Map<number, Avatar>();
  const oneShots: OneShot[] = [];
  let fieldHandles: FieldHandles | null = null;
  const platformTargets = new Map<number, number>(); // id → latest pos (col)
  let headGroup: THREE.Group | null = null;
  let headSpin: THREE.Group | null = null; // rotates for gaze
  let eyeMats: THREE.MeshLambertMaterial[] = [];
  let redLight: THREE.PointLight | null = null;
  let snakeGroups: THREE.Group[] = []; // procedural hair — writhes as she turns

  let lastNow = 0;
  let clockT = 0; // renderer-local seconds
  let lastGaze: MedusaGazeState | 'none' = 'none';
  let lastPhase = '';
  let redFade = 0; // 0..1 vignette amount
  let finishedSeen = 0;

  // damped camera state
  const camCenter = new THREE.Vector3(2, 0, 8);
  let camHalfW = 12;

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
    scene.background = new THREE.Color(SCENE_BG);
    scene.fog = new THREE.Fog(SCENE_BG, 55, 110);
    camera = new THREE.OrthographicCamera(-12, 12, 7, -7, 0.1, 300);
    faceCam = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
    addRoots();
    addLights(scene);
  }

  function addRoots() {
    if (!scene) return;
    fieldRoot = new THREE.Group();
    actorsRoot = new THREE.Group();
    scene.add(fieldRoot);
    scene.add(actorsRoot);
  }

  // A replay starts a fresh round (new pits, everyone back at the start):
  // tear the scene down and rebuild from the next snapshot.
  function resetRound() {
    if (!scene) return;
    scene.clear();
    addRoots();
    addLights(scene);
    avatars.clear();
    oneShots.length = 0;
    fieldHandles = null;
    platformTargets.clear();
    headGroup = null;
    headSpin = null;
    redLight = null;
    eyeMats = [];
    snakeGroups = [];
    built = false;
    finishedSeen = 0;
    lastGaze = 'none';
    redFade = 0;
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
        snakeGroups = []; // the glb replaces the procedural snakes
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
    snakeGroups = [];
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
      snake.userData.baseZ = snake.rotation.z;
      snake.userData.baseX = snake.rotation.x;
      snake.userData.phase = i * 1.7;
      snakeGroups.push(snake);
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

  // ------------------------------------------------------------ one-shots
  function spawnRing(x: number, z: number, color: string) {
    if (!actorsRoot) return;
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

  function spawnDust(x: number, z: number) {
    if (!actorsRoot) return;
    for (let i = 0; i < 6; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0x9a917f, transparent: true, opacity: 0.8 }),
      );
      const a = Math.random() * Math.PI * 2;
      const r = 0.15 + Math.random() * 0.25;
      puff.position.set(x, 0.1, z);
      actorsRoot.add(puff);
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

    if (!built && scene && fieldRoot && actorsRoot) {
      fieldHandles = buildField(fieldRoot, layoutFromSnapshot(s));
      for (const [id, , , , pos] of s.platforms) platformTargets.set(id, pos);
      buildMedusaHead(s.length, (s.lanes - 1) / 2);
      built = true;
      // Initialize avatars at their cells without hop animation.
      for (const [slot, col, lane] of s.players) {
        const av = makeAvatar(slot, colors.get(slot) ?? '#999', actorsRoot);
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

    for (const [slot, col, lane, state, gz, , tier] of s.players) {
      let av = avatars.get(slot);
      if (!av) {
        if (!actorsRoot) continue;
        av = makeAvatar(slot, colors.get(slot) ?? '#999', actorsRoot);
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
      av.cellCol = col;
      av.cellLane = lane;
      const ferryCell =
        (fieldHandles?.pitKeys.has(lane * 1000 + col) ?? false) &&
        state !== ST_FINISHED &&
        state !== ST_FALLEN;
      if (Math.abs(tx - av.tx) > 0.001 || Math.abs(tz - av.tz) > 0.001) {
        if ((av.onFerry || av.attachAfter) && ferryCell) {
          // Still riding (or mid-boarding-hop): the server cell drifts with
          // the ferry — NEVER a new hop. followFerry()/the per-frame
          // retarget keep the avatar glued to the slab.
          av.tx = tx;
          av.tz = tz;
        } else {
          // A real hop: onto solid ground, onto a ferry (arc onto the
          // slab's ACTUAL position, then attach), or off one.
          av.fromX = av.x;
          av.fromZ = av.z;
          av.fromY = av.onFerry ? FERRY_TOP : 0;
          av.toY = ferryCell ? FERRY_TOP : 0;
          av.tx = tx;
          av.tz = tz;
          av.hopStart = clockT;
          av.onFerry = false;
          av.attachAfter = ferryCell;
          if (ferryCell && fieldHandles) {
            for (const [id, def] of fieldHandles.platformDefs) {
              if (def.lane === lane && col >= def.c0 && col <= def.c1) {
                const mesh = fieldHandles.platformMeshes.get(id);
                if (mesh) av.tx = mesh.position.x + ox * 0.3;
                break;
              }
            }
            av.tz = lane + oz * 0.3;
          }
        }
      }
      if (state !== av.state) {
        if (state === ST_STONE) {
          av.stoneAt = clockT;
          turnToStone(av);
          sfx.crack();
        }
        if (state === ST_FALLEN) {
          // Blind hop into open air — the arc plays out, then the sink
          // (updateAvatarMotion) swallows them. Dust marks the spot.
          av.onFerry = false;
          av.fallAt = clockT + HOP_DUR;
          spawnDust(av.tx, av.tz);
        }
        av.state = state;
      }
      setBlindfold(av, gz === 1 && state === ST_RUN); // GZ_CLOSED
      if (tier !== av.tier) applyTier(av, tier);
    }
    for (const slot of s.pings) {
      const av = avatars.get(slot);
      if (av) {
        av.pingUntil = clockT + 2;
        spawnRing(av.x, av.z, av.color);
      }
    }

    for (const [id, , , , pos] of s.platforms) platformTargets.set(id, pos);
    for (const [col, lane, stage] of s.crumble) {
      const cell = fieldHandles?.crumbleCells.get(lane * 1000 + col);
      if (cell && stage > cell.stage) {
        styleCrumble(cell, stage, stage === 2 ? spawnDust : undefined);
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

    if (fieldHandles) {
      lerpPlatforms(fieldHandles, platformTargets, dt);
      // A boarding hop chases the slab's LIVE position so it lands exactly
      // on it — then followFerry glues the rider on with zero drift.
      for (const av of avatars.values()) {
        if (av.attachAfter && av.hopStart >= 0) {
          const mesh = ferryMeshFor(av, fieldHandles);
          if (mesh) av.tx = mesh.position.x + subCellOffset(av.slot)[0] * 0.3;
        }
      }
    }
    for (const av of avatars.values()) updateAvatarMotion(av, dt, clockT);
    if (fieldHandles) {
      for (const av of avatars.values()) {
        if (av.onFerry && av.hopStart < 0) followFerry(av, fieldHandles);
      }
    }
    updateHead(dt);
    updateOneShots();
    updateCamera(s, w / h, dt);

    // v2 red light: the projector cuts to her face, fullscreen. The field
    // and every runner are HIDDEN — all field information exists only on
    // the phones, so there is nothing to gain by peeking at the big screen.
    const faceCut =
      s.eyesMode && s.phase === 'play' && s.gaze.state === 'red' && !!faceCam && !!headGroup;
    if (fieldRoot) fieldRoot.visible = !faceCut;
    if (actorsRoot) actorsRoot.visible = !faceCut;
    if (faceCut && faceCam && headGroup) {
      const hx = headGroup.position.x;
      const hz = headGroup.position.z;
      // Stay in front of the face as her head sweeps: orbit with the yaw.
      const yaw = (headSpin?.rotation.y ?? 0) * 0.8;
      const D = 6.4;
      faceCam.aspect = w / h;
      faceCam.position.set(
        hx - Math.cos(yaw) * D,
        3.2 + Math.sin(clockT * 0.7) * 0.15,
        hz + Math.sin(yaw) * D + Math.sin(clockT * 0.5) * 0.3,
      );
      faceCam.lookAt(hx, 2.5, hz);
      faceCam.updateProjectionMatrix();
      renderer.render(scene, faceCam);
    } else {
      renderer.render(scene, camera);
    }
    drawOverlay(s, w, h, dpr, faceCut);
  }

  function updateHead(dt: number) {
    if (!headSpin || !snap) return;
    // Target yaw: PI = facing away (green), 0 = facing the field (red).
    // During red her head tracks the sweeping gaze — the eyes visibly
    // swivel across the field (and, in a v2 round, toward whoever is
    // deepest in trouble).
    const g = snap.gaze;
    let target: number;
    if (g.state === 'green') target = Math.PI;
    else if (g.state === 'red') target = g.dir ?? 0;
    else if (g.state === 'turning') target = Math.PI * (g.tLeft / TURN_TIME);
    else target = Math.PI * (1 - g.tLeft / TURN_TIME);
    const k = 1 - Math.exp(-14 * dt);
    headSpin.rotation.y += (target - headSpin.rotation.y) * k;

    // The snakes writhe — hardest during the telegraph, agitated while she
    // watches, barely stirring while she faces away.
    const writhe =
      snap.phase !== 'play'
        ? 0.04
        : g.state === 'turning'
          ? 0.3
          : g.state === 'red'
            ? 0.16
            : 0.04;
    for (const snake of snakeGroups) {
      const p = snake.userData.phase as number;
      snake.rotation.z =
        (snake.userData.baseZ as number) + Math.sin(clockT * (5 + writhe * 14) + p) * writhe;
      snake.rotation.x =
        (snake.userData.baseX as number) + Math.cos(clockT * (4 + writhe * 11) + p * 1.3) * writhe * 0.7;
    }

    const red = g.state === 'red' && snap.phase === 'play';
    redFade += ((red ? 1 : 0) - redFade) * (1 - Math.exp(-8 * dt));
    // Eye glow pulses harder as her current target nears petrification.
    let danger = 0;
    if (red && g.target > 0) {
      const tuple = snap.players.find((p) => p[0] === g.target);
      if (tuple) danger = tuple[5] / 100;
    }
    const pulse = red && danger > 0 ? 0.15 * Math.abs(Math.sin(clockT * (4 + danger * 8))) : 0;
    for (const m of eyeMats) {
      m.emissive.setRGB(0.25 + redFade * (0.75 + danger * 0.6) + pulse, 0.02, 0.02);
    }
    if (redLight) redLight.intensity = redFade * (3.2 + danger * 2.5);
    // Hiss: ramps up through the turning telegraph (the audible "she's
    // coming" cue in both modes), stays on through red — in v2 growing
    // louder as anyone's meter climbs — and dies away on green.
    if (snap.phase !== 'play') {
      sfx.hiss(0);
    } else if (g.state === 'turning') {
      sfx.hiss(0.2 + 0.5 * (1 - g.tLeft / TURN_TIME));
    } else if (red) {
      let maxMeter = 0;
      if (snap.eyesMode) {
        for (const p of snap.players) {
          if (p[3] === ST_RUN && p[5] > maxMeter) maxMeter = p[5];
        }
      }
      sfx.hiss(snap.eyesMode ? 0.25 + (maxMeter / 100) * 0.75 : 0.3);
    } else {
      sfx.hiss(redFade * 0.15);
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

  function updateCamera(s: MedusaSnapshot, aspect: number, dt: number) {
    if (!camera) return;
    // Bounds of everyone still on the field (statues included — they're the
    // story), plus a peek ahead of the leaders.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const av of avatars.values()) {
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

    const center = new THREE.Vector3(cx, 0.5, cz);
    const k = 1 - Math.exp(-3.2 * dt);
    camCenter.lerp(center, k);

    // Fit the ortho frustum to the bounds at this iso angle.
    camera.position.copy(camCenter).addScaledVector(ISO_DIR, 60);
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

  function drawOverlay(
    s: MedusaSnapshot,
    w: number,
    h: number,
    dpr: number,
    faceCut: boolean,
  ) {
    if (!overlay || !camera) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (faceCut) {
      // Fullscreen face: no labels, no positions — only the instruction and
      // who the stone is creeping up.
      drawFaceCutOverlay(ctx, s, w, h);
      drawHud(ctx, s, w, h, true);
      return;
    }

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

    drawHud(ctx, s, w, h, false);
  }

  // Overlay for the v2 red-light face cut: red wash, the one-breath rule,
  // and an "endangered" strip — the numbers the stone is creeping up,
  // colored by tier. Legible escalation with zero position leakage.
  function drawFaceCutOverlay(
    ctx: CanvasRenderingContext2D,
    s: MedusaSnapshot,
    w: number,
    h: number,
  ) {
    const grad = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.3,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.75,
    );
    grad.addColorStop(0, 'rgba(120, 10, 20, 0.05)');
    grad.addColorStop(1, `rgba(160, 10, 25, ${0.35 + 0.1 * Math.abs(Math.sin(clockT * 2))})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(h * 0.05)}px system-ui`;
    ctx.fillStyle = '#ffd9dc';
    ctx.fillText('CLOSE YOUR EYES — KEEP MOVING', w / 2, h * 0.9);

    // Endangered numbers, worst first.
    const endangered = s.players
      .filter((p) => p[3] === ST_RUN && (p[6] > 0 || p[5] >= 40))
      .sort((a, b) => b[5] - a[5])
      .slice(0, 12);
    if (endangered.length > 0) {
      ctx.font = `800 ${Math.round(h * 0.038)}px system-ui`;
      const gap = h * 0.075;
      const total = endangered.length * gap;
      endangered.forEach((p, i) => {
        const x = w / 2 - total / 2 + gap * (i + 0.5);
        const y = h * 0.8;
        const tier = p[6];
        const color = p[5] >= 85 ? '#ff5964' : tier >= 2 ? '#ff9b54' : '#ffe066';
        ctx.fillStyle = 'rgba(10, 8, 14, 0.65)';
        ctx.beginPath();
        ctx.roundRect(x - gap * 0.42, y - gap * 0.36, gap * 0.84, gap * 0.72, 8);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(String(p[0]).padStart(2, '0'), x, y);
      });
    }
  }

  function drawHud(
    ctx: CanvasRenderingContext2D,
    s: MedusaSnapshot,
    w: number,
    h: number,
    faceCut: boolean,
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
    const fallen = s.players.filter((p) => p[3] === ST_FALLEN).length;
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(h * 0.03)}px system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(
      `🏃 ${s.aliveCount}   🏁 ${s.finished.length}   🗿 ${stones}` +
        (fallen > 0 ? `   🕳 ${fallen}` : ''),
      w - h * 0.03,
      h * 0.03,
    );

    // Gaze banner (the face cut draws its own instruction).
    if (s.phase === 'play' && !faceCut) {
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
      ctx.fillText(
        s.eyesMode
          ? 'Reach Medusa in time — when she turns, close your eyes and keep moving!'
          : 'Reach Medusa before time runs out — freeze when she turns!',
        w / 2,
        h * 0.8,
      );
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
      const fallen2 = s.players.filter((p) => p[3] === ST_FALLEN).length;
      ctx.font = `700 ${Math.round(h * 0.032)}px system-ui`;
      ctx.fillStyle = '#b9c0e0';
      ctx.fillText(
        `${s.finished.length} escaped · ${stones2} statues` +
          (fallen2 > 0 ? ` · ${fallen2} fell` : ''),
        w / 2,
        h / 2 + ph * 0.4,
      );
    }
  }

  function dispose() {
    sfx.hiss(0);
    renderer?.dispose();
    if (container) container.innerHTML = '';
    scene = null;
    renderer = null;
    overlay = null;
    camera = null;
    avatars.clear();
    oneShots.length = 0;
    fieldHandles = null;
    platformTargets.clear();
    built = false;
  }

  return { mount, push, frame, dispose };
}
