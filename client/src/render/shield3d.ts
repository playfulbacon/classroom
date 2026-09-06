// The phone's mirrored bronze shield, in real 3D (code-split — phones load
// this chunk only in eye-mode Medusa rounds). It renders the SAME art and
// the SAME isometric camera as the stage (via medusaScene.ts), centered on
// the player, horizontally mirrored — a true reflection. The bronze rim
// (shield.ts) sits on an unmirrored 2D canvas above it and limits the view
// to a small circular window: the information loss is the shield's price.
//
// Visible only while Medusa is actually watching (gaze red). Messages are
// applied even while hidden, so the scene is warm the instant she locks on.

import * as THREE from 'three';
import type { MedusaFieldMsg, MedusaShieldMsg } from '../../../shared/protocol';
import {
  ISO_DIR,
  SCENE_BG,
  ST_RUN,
  ST_STONE,
  addLights,
  applyTier,
  buildField,
  layoutFromFieldMsg,
  makeAvatar,
  setBlindfold,
  styleCrumble,
  subCellOffset,
  turnToStone,
  updateAvatarMotion,
  lerpPlatforms,
  type Avatar,
  type FieldHandles,
} from './medusaScene';
import { SHIELD_HOLE_FRAC, drawShieldRim } from './shield';

const VIEW_CELLS = 2.6; // world radius visible inside the shield's hole
const FRESH_MS = 800; // shield msgs older than this = she's not watching

export interface ShieldSources {
  field(): MedusaFieldMsg | null;
  shield(): { msg: MedusaShieldMsg; at: number } | null;
  colors(): Map<number, string>;
  selfSlot(): number;
}

export interface ShieldRenderer3D {
  mount(container: HTMLElement): void;
  dispose(): void;
}

export function createShieldRenderer(src: ShieldSources): ShieldRenderer3D {
  let container: HTMLElement | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let rimCanvas: HTMLCanvasElement | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let raf = 0;

  let builtField: MedusaFieldMsg | null = null; // identity of the built layout
  let fieldHandles: FieldHandles | null = null;
  let fieldRoot: THREE.Group | null = null;
  let actorsRoot: THREE.Group | null = null;
  let selfAvatar: Avatar | null = null;
  const nearAvatars = new Map<number, Avatar>();
  const nearMissed = new Map<number, number>(); // slots absent from recent msgs
  const platformTargets = new Map<number, number>();
  const platformSeen = new Set<number>(); // snap (not lerp) on first sighting
  let appliedMsg: MedusaShieldMsg | null = null;

  let lastNow = 0;
  let clockT = 0;
  const camCenter = new THREE.Vector3(0, 0.5, 0);

  function mount(el: HTMLElement) {
    container = el;
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = 'shield-webgl';
    el.appendChild(renderer.domElement);
    rimCanvas = document.createElement('canvas');
    rimCanvas.className = 'shield-rim';
    el.appendChild(rimCanvas);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(SCENE_BG);
    camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 300);
    addLights(scene);
    fieldRoot = new THREE.Group();
    actorsRoot = new THREE.Group();
    scene.add(fieldRoot);
    scene.add(actorsRoot);
    raf = requestAnimationFrame(frame);
  }

  // A new round sends a fresh 'field' message: rebuild the whole scene.
  function rebuildField(field: MedusaFieldMsg) {
    if (!scene || !fieldRoot || !actorsRoot) return;
    fieldRoot.clear();
    actorsRoot.clear();
    nearAvatars.clear();
    nearMissed.clear();
    platformTargets.clear();
    platformSeen.clear();
    selfAvatar = null;
    appliedMsg = null;
    fieldHandles = buildField(fieldRoot, layoutFromFieldMsg(field));
    builtField = field;
  }

  // Apply one shield message: exactly the stage's push() logic, scoped to
  // the little window the server sends.
  function applyMsg(msg: MedusaShieldMsg, field: MedusaFieldMsg) {
    if (!actorsRoot || !fieldHandles) return;
    const colors = src.colors();
    const slot = src.selfSlot();

    const setTarget = (av: Avatar, avSlot: number, col: number, lane: number, state: number) => {
      const [ox, oz] = subCellOffset(avSlot);
      const tx = col + ox;
      const tz = lane + oz;
      if (Math.abs(tx - av.tx) > 0.001 || Math.abs(tz - av.tz) > 0.001) {
        av.fromX = av.x;
        av.fromZ = av.z;
        av.tx = tx;
        av.tz = tz;
        av.hopStart = clockT;
        // On a pit cell = riding a ferry: slide with it instead of hopping.
        av.glide = fieldHandles!.pitKeys.has(lane * 1000 + col) && state === ST_RUN;
      }
    };

    // Self: center of the reflection.
    const [meCol, meLane, , meTier, meGz] = msg.me;
    if (!selfAvatar) {
      selfAvatar = makeAvatar(slot, colors.get(slot) ?? '#fff', actorsRoot);
      const [ox, oz] = subCellOffset(slot);
      selfAvatar.x = selfAvatar.tx = selfAvatar.fromX = meCol + ox;
      selfAvatar.z = selfAvatar.tz = selfAvatar.fromZ = meLane + oz;
      camCenter.set(selfAvatar.x, 0.5, selfAvatar.z);
    }
    setTarget(selfAvatar, slot, meCol, meLane, ST_RUN);
    setBlindfold(selfAvatar, meGz === 1); // GZ_CLOSED
    if (selfAvatar.tier !== meTier) applyTier(selfAvatar, meTier);

    // Neighbors within the window.
    const present = new Set<number>();
    for (const [nSlot, col, lane, state, tier] of msg.near) {
      present.add(nSlot);
      nearMissed.set(nSlot, 0);
      let av = nearAvatars.get(nSlot);
      if (!av) {
        av = makeAvatar(nSlot, colors.get(nSlot) ?? '#999', actorsRoot);
        const [ox, oz] = subCellOffset(nSlot);
        av.x = av.tx = av.fromX = col + ox;
        av.z = av.tz = av.fromZ = lane + oz;
        if (state === ST_STONE) turnToStone(av);
        av.state = state;
        nearAvatars.set(nSlot, av);
      }
      setTarget(av, nSlot, col, lane, state);
      if (state !== av.state) {
        if (state === ST_STONE) {
          av.stoneAt = clockT;
          turnToStone(av);
        }
        av.state = state;
      }
      if (av.tier !== tier) applyTier(av, tier);
    }
    // Two consecutive absences → left the window (tolerates a dropped
    // packet; the window edge sits outside the visible hole anyway).
    for (const [nSlot, av] of nearAvatars) {
      if (present.has(nSlot)) continue;
      const missed = (nearMissed.get(nSlot) ?? 0) + 1;
      nearMissed.set(nSlot, missed);
      if (missed >= 2) {
        av.group.parent?.remove(av.group);
        nearAvatars.delete(nSlot);
        nearMissed.delete(nSlot);
      }
    }

    // Ferries: snap on first sighting (their defs carry no live position),
    // lerp afterwards.
    for (const [id, pos] of msg.pf) {
      platformTargets.set(id, pos);
      if (!platformSeen.has(id)) {
        platformSeen.add(id);
        const mesh = fieldHandles.platformMeshes.get(id);
        if (mesh) mesh.position.x = pos;
      }
    }

    // Crumble stages advance monotonically.
    for (const [col, lane, stage] of msg.cr) {
      const cell = fieldHandles.crumbleCells.get(lane * 1000 + col);
      if (cell && stage > cell.stage) styleCrumble(cell, stage);
    }
    void field;
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!renderer || !scene || !camera || !container || !rimCanvas) return;
    const now = performance.now();
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    clockT += dt;

    const field = src.field();
    const sh = src.shield();
    if (field && field !== builtField) rebuildField(field);
    if (field && sh && sh.msg !== appliedMsg && field === builtField) {
      appliedMsg = sh.msg;
      applyMsg(sh.msg, field);
    }

    // Only visible while Medusa is watching: fresh AND red.
    const visible = !!(field && sh && now - sh.at < FRESH_MS && sh.msg.g[0] === 2);
    container.style.opacity = visible ? '1' : '0';
    if (!visible || !selfAvatar) return;

    // Resize.
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (rimCanvas.width !== Math.round(w * dpr) || rimCanvas.height !== Math.round(h * dpr)) {
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      rimCanvas.width = Math.round(w * dpr);
      rimCanvas.height = Math.round(h * dpr);
    }

    // Animate exactly like the stage.
    updateAvatarMotion(selfAvatar, dt, clockT);
    for (const av of nearAvatars.values()) updateAvatarMotion(av, dt, clockT);
    if (fieldHandles) lerpPlatforms(fieldHandles, platformTargets, dt);

    // Same iso camera as the stage, centered on the player. The frustum is
    // sized so the rim hole shows VIEW_CELLS of world radius.
    const k = 1 - Math.exp(-8 * dt);
    camCenter.lerp(new THREE.Vector3(selfAvatar.x, 0.5, selfAvatar.z), k);
    camera.position.copy(camCenter).addScaledVector(ISO_DIR, 60);
    camera.lookAt(camCenter);
    const holeR = SHIELD_HOLE_FRAC * Math.min(w, h);
    const halfW = (VIEW_CELLS * (w / 2)) / holeR;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = (halfW * h) / w;
    camera.bottom = -(halfW * h) / w;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    // The bronze rim above (unmirrored — it's the shield, not the image).
    const ctx = rimCanvas.getContext('2d');
    if (ctx && sh && field) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawShieldRim(
        ctx,
        w,
        h,
        { gz: sh.msg.me[4], meterQ: sh.msg.me[2], toGo: field.length - 1 - sh.msg.me[0] },
        now / 1000,
      );
    }
  }

  function dispose() {
    cancelAnimationFrame(raf);
    renderer?.dispose();
    if (container) {
      container.innerHTML = '';
      container.style.opacity = '0';
    }
    scene = null;
    renderer = null;
    camera = null;
    rimCanvas = null;
    fieldHandles = null;
    builtField = null;
    selfAvatar = null;
    nearAvatars.clear();
    platformTargets.clear();
  }

  return { mount, dispose };
}
