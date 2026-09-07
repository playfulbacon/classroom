// Human Tetris: a co-op crowd game. Everyone roams one field with a free
// joystick; a shape's outline appears and a timer runs; at zero the wall —
// the whole field EXCEPT the shape — drops out of the sky and flattens
// anyone (and any NPC) standing outside it. The wall lifts away, a new
// shape appears, and the timer shortens while the shape tightens. Lost NPCs
// keep turning up outside the safe zone; touch one to carry it (one per
// player) and bring it inside before the drop. The crowd loses the game
// when its losses (flattened players + crushed NPCs) reach the budget; the
// score is rounds cleared.

import {
  NPC_CARRIED,
  NPC_CRUSHED,
  NPC_SAVED,
  NPC_WAITING,
  TETRIS_ALIVE,
  TETRIS_DROP_DUR as DROP_DUR,
  TETRIS_OUT,
  TETRIS_REST_DUR as REST_DUR,
  TETRIS_RISE_DUR as RISE_DUR,
  type GamePhase,
  type InputPayload,
  type MeState,
  type TetrisNpcTuple,
  type TetrisPlayerTuple,
  type TetrisPulseMsg,
  type TetrisRoundPhase,
  type TetrisShape,
  type TetrisSnapshot,
} from '../../../shared/protocol';
import { TETRIS_ISO_DIR, groundToScreenDir, screenToGround } from '../../../shared/iso';
import type { GameCtx, GameModule } from './types';
import { generateShape, shapeCells, shapeContains } from './tetrisShapes';

const TICK_MS = 1000 / 20;
const COUNTDOWN = 3;
const SPEED = 4.6; // units/s at full deflection
const ACCEL = 12; // velocity approach rate (1/s)
const PLAYER_R = 0.26;
const INSIDE_SLACK = 0.12; // a toe over the line still counts — the crowd shoves
const PICKUP_DIST = 0.75;
const PING_COOLDOWN = 1.5;
const PULSE_EVERY = 4; // every 4th tick → 5 Hz
const FIRST_TIMER = 14;
const MIN_TIMER = 6;
const TIMER_STEP = 0.6; // seconds shaved off each round
const HURRY_AT = 3; // buzz anyone still outside with this long to go
const NPC_FROM_ROUND = 2;

interface Runner {
  slot: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  joyX: number; // ground-plane joystick, |v| <= 1
  joyZ: number;
  state: typeof TETRIS_ALIVE | typeof TETRIS_OUT;
  carrying: number; // NPC id, 0 when none
  lastPingAt: number;
  hurried: boolean; // got this round's hurry buzz already
}

interface Npc {
  id: number;
  x: number;
  z: number;
  state: number;
  carrier: number;
}

interface BotBrain {
  react: number; // seconds after a shape appears before the bot moves
  lazy: number; // 0..1 — dawdles until this fraction of the timer is gone
  hero: number; // 0..1 — willingness to fetch NPCs
  tx: number;
  tz: number;
  targetRound: number;
  retargetAt: number;
  wanderA: number;
  wanderAt: number;
}

export class HumanTetris implements GameModule {
  readonly id = 'tetris' as const;
  private readonly ctx: GameCtx;
  private readonly runners = new Map<number, Runner>();
  private readonly npcs = new Map<number, Npc>();
  private readonly brains = new Map<number, BotBrain>();
  private fieldW = 16;
  private fieldD = 10;
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private round = 0;
  private roundPhase: TetrisRoundPhase = 'form';
  private pt = 0; // seconds into the current round phase
  private timeLimit = FIRST_TIMER;
  private shape: TetrisShape | null = null;
  private cleared = 0;
  private losses = 0;
  private lossBudget = 3;
  private rescued = 0;
  private lastCrushed: [number[], number[]] = [[], []];
  private pings: number[] = [];
  private nextNpcId = 1;
  private tickCount = 0;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
  }

  start() {
    const slots = this.ctx
      .slots()
      .map((s) => s.slot)
      .sort((a, b) => a - b);
    const n = Math.max(1, slots.length);
    // A field the crowd can cross in a few seconds but can't all fit in
    // one corner of; deeper than it is wide reads badly on the iso camera.
    this.fieldW = Math.max(14, Math.min(34, Math.round(Math.sqrt(n) * 4.6)));
    this.fieldD = Math.max(9, Math.min(22, Math.round(this.fieldW * 0.62)));
    this.lossBudget = Math.max(3, Math.ceil(n * 0.35));
    // Seating-chart start: a centred grid, numbers reading left to right.
    const cols = Math.ceil(Math.sqrt(n * (this.fieldW / this.fieldD)));
    const rows = Math.ceil(n / cols);
    const gapX = Math.min(1.2, (this.fieldW - 2) / cols);
    const gapZ = Math.min(1.2, (this.fieldD - 2) / rows);
    const ox = this.fieldW / 2 - ((cols - 1) * gapX) / 2;
    const oz = this.fieldD / 2 - ((rows - 1) * gapZ) / 2;
    slots.forEach((slot, i) => {
      this.runners.set(slot, this.makeRunner(slot, ox + (i % cols) * gapX, oz + Math.floor(i / cols) * gapZ));
    });
    this.interval = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private makeRunner(slot: number, x: number, z: number): Runner {
    return {
      slot,
      x: this.clampX(x),
      z: this.clampZ(z),
      vx: 0,
      vz: 0,
      joyX: 0,
      joyZ: 0,
      state: TETRIS_ALIVE,
      carrying: 0,
      lastPingAt: -PING_COOLDOWN,
      hurried: false,
    };
  }

  private clampX(x: number) {
    return Math.min(this.fieldW - PLAYER_R, Math.max(PLAYER_R, x));
  }
  private clampZ(z: number) {
    return Math.min(this.fieldD - PLAYER_R, Math.max(PLAYER_R, z));
  }

  // Late joiners drop in INSIDE the current shape (a fair start whatever
  // the timer says); before the first shape, anywhere on the field.
  onJoin(slot: number) {
    if (this.phase === 'over' || this.runners.has(slot)) return;
    let x = 1 + Math.random() * (this.fieldW - 2);
    let z = 1 + Math.random() * (this.fieldD - 2);
    if (this.shape) {
      const cells = shapeCells(this.shape);
      const [cx, cz] = cells[Math.floor(Math.random() * cells.length)];
      x = cx + 0.5;
      z = cz + 0.5;
    }
    this.runners.set(slot, this.makeRunner(slot, x, z));
  }

  input(slot: number, payload: InputPayload) {
    const runner = this.runners.get(slot);
    if (!runner) return;
    if (payload.t === 'ping') {
      const now = this.now();
      if (now - runner.lastPingAt < PING_COOLDOWN) return;
      runner.lastPingAt = now;
      this.pings.push(slot);
      return;
    }
    if (payload.t !== 'joy') return;
    if (runner.state !== TETRIS_ALIVE) return;
    const sx = clampNum(payload.x, -1, 1);
    const sy = clampNum(payload.y, -1, 1);
    const mag = Math.hypot(sx, sy);
    const { x, z } = screenToGround(TETRIS_ISO_DIR, sx, sy);
    const scale = mag > 1 ? 1 / mag : 1;
    runner.joyX = x * scale;
    runner.joyZ = z * scale;
  }

  // Monotonic game clock for cooldowns (round phases reset pt).
  private clock = 0;
  private now() {
    return this.clock;
  }

  private canMove(): boolean {
    return (
      this.phase === 'play' && (this.roundPhase === 'form' || this.roundPhase === 'rise')
    );
  }

  // Inside the safe zone, with a little slack: a player whose centre is a
  // toe's width outside still counts. Being packed at the edge by the crowd
  // at the wrong instant shouldn't be the thing that flattens you.
  private inside(x: number, z: number): boolean {
    const shape = this.shape;
    if (!shape) return false;
    if (shapeContains(shape, x, z)) return true;
    const s = INSIDE_SLACK;
    return (
      shapeContains(shape, x + s, z) ||
      shapeContains(shape, x - s, z) ||
      shapeContains(shape, x, z + s) ||
      shapeContains(shape, x, z - s)
    );
  }

  private aliveRunners(): Runner[] {
    return [...this.runners.values()].filter((r) => r.state === TETRIS_ALIVE);
  }

  // ------------------------------------------------------------- rounds

  private beginRound() {
    this.round++;
    this.roundPhase = 'form';
    this.pt = 0;
    this.timeLimit = Math.max(MIN_TIMER, FIRST_TIMER - (this.round - 1) * TIMER_STEP);
    const alive = this.aliveRunners();
    // The shape tightens round by round: a cell comfortably holds two
    // players, so under ~0.55 cells per head the crowd has to pack.
    const cellsPerHead = Math.max(0.5, 1.0 - (this.round - 1) * 0.06);
    const minCells = Math.max(3, Math.ceil(alive.length * cellsPerHead) + 1);
    this.shape = generateShape(this.fieldW, this.fieldD, minCells);
    for (const r of alive) r.hurried = false;
    // Lost NPCs turn up outside the safe zone, more of them for a bigger
    // crowd, but never so many that the waiting pile grows unbounded.
    if (this.round >= NPC_FROM_ROUND) {
      const waiting = [...this.npcs.values()].filter((n) => n.state === NPC_WAITING).length;
      const cap = Math.ceil(alive.length / 4) + 1;
      const spawn = Math.min(Math.max(1, Math.round(alive.length / 8)), Math.max(0, cap - waiting));
      for (let i = 0; i < spawn; i++) this.spawnNpc();
    }
    this.lastCrushed = [[], []];
    for (const r of alive) {
      this.ctx.buzz(r.slot, 'go');
      this.ctx.emitMe(r.slot);
    }
  }

  private spawnNpc() {
    const shape = this.shape;
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      x = 0.6 + Math.random() * (this.fieldW - 1.2);
      z = 0.6 + Math.random() * (this.fieldD - 1.2);
      if (!shape) break;
      // Outside the shape's box with a cell of clearance — genuinely
      // stranded, not a free rescue.
      const clear =
        x < shape.x0 - 1 || x > shape.x0 + shape.w + 1 || z < shape.z0 - 1 || z > shape.z0 + shape.h + 1;
      if (clear || (attempt > 40 && !shapeContains(shape, x, z))) break;
    }
    const id = this.nextNpcId++;
    this.npcs.set(id, { id, x, z, state: NPC_WAITING, carrier: 0 });
  }

  // The timer hit zero: the wall falls on everyone outside the shape.
  private dropWall() {
    const crushedSlots: number[] = [];
    const crushedNpcs: number[] = [];
    for (const r of this.runners.values()) {
      if (r.state !== TETRIS_ALIVE) continue;
      r.vx = r.vz = 0;
      r.joyX = r.joyZ = 0;
      if (this.inside(r.x, r.z)) continue;
      r.state = TETRIS_OUT;
      crushedSlots.push(r.slot);
      this.losses++;
      this.ctx.buzz(r.slot, 'eliminated');
    }
    for (const n of this.npcs.values()) {
      if (n.state === NPC_CARRIED) {
        const carrier = this.runners.get(n.carrier);
        if (carrier && carrier.state === TETRIS_ALIVE) {
          n.state = NPC_SAVED;
          this.rescued++;
          carrier.carrying = 0;
          this.ctx.buzz(carrier.slot, 'rescued');
        } else {
          n.state = NPC_CRUSHED;
          if (carrier) carrier.carrying = 0;
        }
      } else if (n.state === NPC_WAITING) {
        n.state = this.inside(n.x, n.z) ? NPC_SAVED : NPC_CRUSHED;
        if (n.state === NPC_SAVED) this.rescued++;
      }
      if (n.state === NPC_CRUSHED) {
        crushedNpcs.push(n.id);
        this.losses++;
      }
    }
    this.lastCrushed = [crushedSlots, crushedNpcs];
    this.roundPhase = 'drop';
    this.pt = 0;
    for (const r of this.runners.values()) this.ctx.emitMe(r.slot);
  }

  private endGame() {
    this.phase = 'over';
    for (const r of this.runners.values()) this.ctx.emitMe(r.slot);
  }

  // ------------------------------------------------------------ physics

  private integrate(dt: number) {
    const k = 1 - Math.exp(-ACCEL * dt);
    for (const r of this.runners.values()) {
      if (r.state !== TETRIS_ALIVE) continue;
      r.vx += (r.joyX * SPEED - r.vx) * k;
      r.vz += (r.joyZ * SPEED - r.vz) * k;
      r.x = this.clampX(r.x + r.vx * dt);
      r.z = this.clampZ(r.z + r.vz * dt);
    }
    // Soft separation so the crowd packs without stacking.
    const alive = this.aliveRunners();
    const minD = PLAYER_R * 2;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= minD) continue;
        let nx: number;
        let nz: number;
        if (d < 1e-4) {
          const ang = ((a.slot * 7 + b.slot * 13) % 360) * (Math.PI / 180);
          nx = Math.cos(ang);
          nz = Math.sin(ang);
        } else {
          nx = dx / d;
          nz = dz / d;
        }
        const push = (minD - d) * 0.5;
        a.x = this.clampX(a.x - nx * push);
        a.z = this.clampZ(a.z - nz * push);
        b.x = this.clampX(b.x + nx * push);
        b.z = this.clampZ(b.z + nz * push);
      }
    }
    // Carried NPCs ride their carrier; free ones get scooped on contact.
    for (const n of this.npcs.values()) {
      if (n.state === NPC_CARRIED) {
        const c = this.runners.get(n.carrier);
        if (c) {
          n.x = c.x;
          n.z = c.z;
        }
      }
    }
    for (const r of alive) {
      if (r.carrying) continue;
      let best: Npc | null = null;
      let bestD = PICKUP_DIST;
      for (const n of this.npcs.values()) {
        if (n.state !== NPC_WAITING) continue;
        const d = Math.hypot(n.x - r.x, n.z - r.z);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) {
        best.state = NPC_CARRIED;
        best.carrier = r.slot;
        best.x = r.x;
        best.z = r.z;
        r.carrying = best.id;
        this.ctx.buzz(r.slot, 'pickup');
        this.ctx.emitMe(r.slot);
      }
    }
  }

  // ---------------------------------------------------------------- bots

  // Fake-player AI: head for a spot inside the shape (spreading out, with
  // human reaction lag and a streak of laziness), fetch stranded NPCs when
  // there's time — and, being human, some of them WILL be outside when the
  // wall lands.
  botInput(slot: number): InputPayload | InputPayload[] | null {
    const r = this.runners.get(slot);
    if (!r || r.state !== TETRIS_ALIVE || this.phase !== 'play') return null;
    let brain = this.brains.get(slot);
    if (!brain) {
      brain = {
        react: 0.2 + Math.random() * 0.9,
        lazy: Math.random() * Math.random(), // most are keen, a few dawdle
        hero: Math.random(),
        tx: r.x,
        tz: r.z,
        targetRound: -1,
        retargetAt: 0,
        wanderA: Math.random() * Math.PI * 2,
        wanderAt: 0,
      };
      this.brains.set(slot, brain);
    }
    const shape = this.shape;
    if (!shape || this.roundPhase !== 'form') return { t: 'joy', x: 0, y: 0 };
    const tLeft = this.timeLimit - this.pt;
    if (this.pt < brain.react) return { t: 'joy', x: 0, y: 0 };
    // Dawdle: wander until the lazy fraction of the timer is spent.
    if (this.pt < this.timeLimit * brain.lazy * 0.6 && !r.carrying) {
      if (this.now() >= brain.wanderAt) {
        brain.wanderA += (Math.random() - 0.5) * 2;
        brain.wanderAt = this.now() + 0.6 + Math.random();
      }
      return this.joyToward(r, r.x + Math.cos(brain.wanderA), r.z + Math.sin(brain.wanderA), 0.5);
    }
    // Heroics: fetch the nearest stranded NPC if the trip there and back
    // into the shape fits in the time left.
    if (!r.carrying && brain.hero > 0.35) {
      let best: Npc | null = null;
      let bestD = Infinity;
      for (const n of this.npcs.values()) {
        if (n.state !== NPC_WAITING) continue;
        const d = Math.hypot(n.x - r.x, n.z - r.z);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) {
        const back = this.nearestCellDist(best.x, best.z);
        if ((bestD + back) / SPEED + 1.2 < tLeft) return this.joyToward(r, best.x, best.z, 1);
      }
    }
    // Pick (and occasionally re-pick) a cell inside the shape, favouring
    // near, uncrowded, interior ones with a little jitter so the crowd
    // spreads — edge cells are where the shoving gets you.
    if (brain.targetRound !== this.round || this.now() >= brain.retargetAt) {
      brain.targetRound = this.round;
      brain.retargetAt = this.now() + 1 + Math.random() * 1.5;
      const alive = this.aliveRunners();
      let best: [number, number] | null = null;
      let bestScore = Infinity;
      for (const [cx, cz] of shapeCells(shape)) {
        const mx = cx + 0.5;
        const mz = cz + 0.5;
        let crowd = 0;
        for (const o of alive) {
          if (o !== r && Math.abs(o.x - mx) < 0.5 && Math.abs(o.z - mz) < 0.5) crowd++;
        }
        let exposed = 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!shapeContains(shape, mx + dc, mz + dr)) exposed++;
        }
        const score =
          Math.hypot(mx - r.x, mz - r.z) + crowd * 1.4 + exposed * 0.45 + Math.random() * 1.2;
        if (score < bestScore) {
          bestScore = score;
          best = [mx + (Math.random() - 0.5) * 0.3, mz + (Math.random() - 0.5) * 0.3];
        }
      }
      if (best) [brain.tx, brain.tz] = best;
    }
    const d = Math.hypot(brain.tx - r.x, brain.tz - r.z);
    if (d < 0.12 && this.inside(r.x, r.z)) return { t: 'joy', x: 0, y: 0 };
    if (d < 0.12) {
      brain.retargetAt = 0; // shoved out by the crowd — pick again
      return { t: 'joy', x: 0, y: 0 };
    }
    return this.joyToward(r, brain.tx, brain.tz, 1);
  }

  private nearestCellDist(x: number, z: number): number {
    if (!this.shape) return 0;
    let best = Infinity;
    for (const [cx, cz] of shapeCells(this.shape)) {
      best = Math.min(best, Math.hypot(cx + 0.5 - x, cz + 0.5 - z));
    }
    return best === Infinity ? 0 : best;
  }

  // Bots push a screen-space joystick exactly like a thumb would.
  private joyToward(r: Runner, tx: number, tz: number, mag: number): InputPayload {
    const dx = tx - r.x;
    const dz = tz - r.z;
    if (Math.hypot(dx, dz) < 1e-3) return { t: 'joy', x: 0, y: 0 };
    const s = groundToScreenDir(TETRIS_ISO_DIR, dx, dz);
    return { t: 'joy', x: s.x * mag, y: s.y * mag };
  }

  // ------------------------------------------------------------ personal

  personal(slot: number): Partial<MeState> {
    const r = this.runners.get(slot);
    if (!r) return { waiting: true };
    return {
      tetrisState: r.state === TETRIS_ALIVE ? 'alive' : 'out',
      round: this.round,
      carrying: r.carrying !== 0,
      cleared: this.cleared,
      gameOver: this.phase === 'over',
    };
  }

  // ---------------------------------------------------------------- tick

  private tick(dt: number) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'play';
        this.beginRound();
      }
      this.emitSnapshot();
      return;
    }
    if (this.phase === 'over') {
      this.emitSnapshot();
      return;
    }

    this.clock += dt;
    this.pt += dt;
    if (this.canMove()) this.integrate(dt);

    if (this.roundPhase === 'form') {
      const tLeft = this.timeLimit - this.pt;
      if (tLeft <= HURRY_AT) {
        for (const r of this.runners.values()) {
          if (r.state !== TETRIS_ALIVE || r.hurried || this.inside(r.x, r.z)) continue;
          r.hurried = true;
          this.ctx.buzz(r.slot, 'hurry');
        }
      }
      if (this.pt >= this.timeLimit) this.dropWall();
    } else if (this.roundPhase === 'drop') {
      if (this.pt >= DROP_DUR) {
        this.roundPhase = 'rest';
        this.pt = 0;
      }
    } else if (this.roundPhase === 'rest') {
      if (this.pt >= REST_DUR) {
        if (this.losses >= this.lossBudget || this.aliveRunners().length === 0) {
          this.endGame();
        } else {
          this.cleared++;
          for (const [id, n] of this.npcs) {
            if (n.state === NPC_SAVED || n.state === NPC_CRUSHED) this.npcs.delete(id);
          }
          this.roundPhase = 'rise';
          this.pt = 0;
        }
      }
    } else if (this.roundPhase === 'rise') {
      if (this.pt >= RISE_DUR) this.beginRound();
    }

    this.tickCount++;
    if (this.tickCount % PULSE_EVERY === 0) this.emitPulses();
    this.emitSnapshot();
  }

  private emitPulses() {
    const phaseCode =
      this.roundPhase === 'form' ? 0 : this.roundPhase === 'drop' ? 1 : this.roundPhase === 'rest' ? 2 : 3;
    const tLeft = this.roundPhase === 'form' ? round1(Math.max(0, this.timeLimit - this.pt)) : 0;
    for (const r of this.runners.values()) {
      if (r.state !== TETRIS_ALIVE || this.ctx.isBot(r.slot)) continue;
      const msg: TetrisPulseMsg = [this.inside(r.x, r.z) ? 1 : 0, tLeft, phaseCode, r.carrying ? 1 : 0];
      this.ctx.send(r.slot, 'pulse', msg);
    }
  }

  private emitSnapshot() {
    const players: TetrisPlayerTuple[] = [...this.runners.values()].map((r) => [
      r.slot,
      round2(r.x),
      round2(r.z),
      r.state,
      r.carrying,
    ]);
    const npcs: TetrisNpcTuple[] = [...this.npcs.values()].map((n) => [
      n.id,
      round2(n.x),
      round2(n.z),
      n.state,
      n.carrier,
    ]);
    const snapshot: TetrisSnapshot = {
      kind: 'tetris',
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      round: this.round,
      roundPhase: this.roundPhase,
      pt: round2(this.pt),
      tLeft: this.roundPhase === 'form' ? round1(Math.max(0, this.timeLimit - this.pt)) : 0,
      timeLimit: this.timeLimit,
      fieldW: this.fieldW,
      fieldD: this.fieldD,
      shape: this.shape,
      players,
      npcs,
      pings: this.pings,
      cleared: this.cleared,
      losses: this.losses,
      lossBudget: this.lossBudget,
      rescued: this.rescued,
      aliveCount: this.aliveRunners().length,
      lastCrushed: this.lastCrushed,
    };
    this.pings = [];
    this.ctx.emitStage(snapshot);
  }
}

function clampNum(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(max, Math.max(min, n));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
