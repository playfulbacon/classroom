// Human Tetris: a co-op crowd game. Everyone roams one field with a free
// joystick; a shape's outline appears and a timer runs; at zero the wall —
// the whole field EXCEPT the shape — drops out of the sky and flattens
// anyone (and any NPC) standing outside it. The wall lifts away, a new
// shape appears, and the timer shortens. Lost NPCs keep turning up outside
// the safe zone, more every round; walk into one to carry it (one per
// player), tap to set it down in the cell ahead. Flattened players and
// crushed NPCs count toward a loss budget; the score is rounds cleared.
//
// Cells are EXCLUSIVE: one occupant per cell — a player (with or without a
// rider) or a waiting NPC. Walking into an occupied cell barges the
// occupant aside (sideways if there's room, else straight ahead, chain
// and all). The shape always has at least one cell per person and per
// NPC, so it is always physically fillable — but only if the crowd sorts
// itself out.

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
import { generateShape, shapeCells, shapeContains, shapeHasCell } from './tetrisShapes';

const TICK_MS = 1000 / 20;
const COUNTDOWN = 3;
const SPEED = 4.6; // units/s at full deflection
const ACCEL = 12; // velocity approach rate (1/s)
const EDGE = 0.2; // keep this far from the field edge
const SHOVE_STUN = 0.3; // a just-barged occupant can't barge back for this long
const SHOVE_CHAIN = 8; // longest forward chain a barge can push
const BARGE_COST = 3; // bots: pushing through someone ~ a three-cell detour
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
  faceX: number; // last movement direction (unit-ish) — where "ahead" is
  faceZ: number;
  state: typeof TETRIS_ALIVE | typeof TETRIS_OUT;
  carrying: number; // NPC id, 0 when none
  lastPingAt: number;
  shovedAt: number; // clock of the last barge that moved this player
  hurried: boolean; // got this round's hurry buzz already
}

interface Npc {
  id: number;
  x: number;
  z: number;
  state: number;
  carrier: number;
}

// What stands in a cell: a player or a waiting NPC.
type Occupant = { kind: 'p'; r: Runner } | { kind: 'n'; n: Npc };

interface BotBrain {
  react: number; // seconds after a shape appears before the bot moves
  lazy: number; // 0..1 — dawdles until this fraction of the timer is gone
  hero: number; // 0..1 — willingness to fetch NPCs
  tx: number;
  tz: number;
  targetRound: number;
  retargetAt: number;
  shoveSeen: number; // last shovedAt reacted to
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
  private clock = 0; // monotonic play clock for cooldowns
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
    // Seating-chart start: one per cell on a centred grid, numbers reading
    // left to right.
    const cols = Math.min(this.fieldW - 2, Math.ceil(Math.sqrt(n * (this.fieldW / this.fieldD))));
    const rows = Math.ceil(n / cols);
    const cx0 = Math.floor((this.fieldW - cols) / 2);
    const cz0 = Math.max(0, Math.floor((this.fieldD - rows) / 2));
    slots.forEach((slot, i) => {
      const cx = cx0 + (i % cols);
      const cz = Math.min(this.fieldD - 1, cz0 + Math.floor(i / cols));
      this.runners.set(slot, this.makeRunner(slot, cx + 0.5, cz + 0.5));
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
      faceX: 0,
      faceZ: 1,
      state: TETRIS_ALIVE,
      carrying: 0,
      lastPingAt: -PING_COOLDOWN,
      shovedAt: -Infinity,
      hurried: false,
    };
  }

  private clampX(x: number) {
    return Math.min(this.fieldW - EDGE, Math.max(EDGE, x));
  }
  private clampZ(z: number) {
    return Math.min(this.fieldD - EDGE, Math.max(EDGE, z));
  }

  // ----------------------------------------------------------- occupancy

  private cellKey(cx: number, cz: number): number {
    return cz * 1000 + cx;
  }

  private inField(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.fieldW && cz < this.fieldD;
  }

  // Who stands where right now (alive players + waiting NPCs).
  private occupancy(): Map<number, Occupant> {
    const occ = new Map<number, Occupant>();
    for (const r of this.runners.values()) {
      if (r.state === TETRIS_ALIVE) occ.set(this.cellKey(Math.floor(r.x), Math.floor(r.z)), { kind: 'p', r });
    }
    for (const n of this.npcs.values()) {
      if (n.state === NPC_WAITING) occ.set(this.cellKey(Math.floor(n.x), Math.floor(n.z)), { kind: 'n', n });
    }
    return occ;
  }

  private freeCell(occ: Map<number, Occupant>, cx: number, cz: number): boolean {
    return this.inField(cx, cz) && !occ.has(this.cellKey(cx, cz));
  }

  // A random free cell, preferring ones for which `prefer` holds.
  private randomFreeCell(
    occ: Map<number, Occupant>,
    prefer: (cx: number, cz: number) => boolean,
  ): [number, number] | null {
    const good: [number, number][] = [];
    const any: [number, number][] = [];
    for (let cx = 0; cx < this.fieldW; cx++) {
      for (let cz = 0; cz < this.fieldD; cz++) {
        if (occ.has(this.cellKey(cx, cz))) continue;
        any.push([cx, cz]);
        if (prefer(cx, cz)) good.push([cx, cz]);
      }
    }
    const pool = good.length > 0 ? good : any;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  // Late joiners drop into a free cell INSIDE the current shape (a fair
  // start whatever the timer says); before the first shape, anywhere.
  onJoin(slot: number) {
    if (this.phase === 'over' || this.runners.has(slot)) return;
    const shape = this.shape;
    const cell = this.randomFreeCell(this.occupancy(), (cx, cz) =>
      shape ? shapeHasCell(shape, cx, cz) : true,
    );
    const [cx, cz] = cell ?? [Math.floor(this.fieldW / 2), Math.floor(this.fieldD / 2)];
    this.runners.set(slot, this.makeRunner(slot, cx + 0.5, cz + 0.5));
  }

  // ---------------------------------------------------------------- input

  input(slot: number, payload: InputPayload) {
    const runner = this.runners.get(slot);
    if (!runner) return;
    if (payload.t === 'place' && runner.carrying && runner.state === TETRIS_ALIVE) {
      this.placeNpc(runner);
      return;
    }
    if (payload.t === 'ping' || payload.t === 'place') {
      if (this.clock - runner.lastPingAt < PING_COOLDOWN) return;
      runner.lastPingAt = this.clock;
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
    if (mag > 0.2) {
      const len = Math.hypot(x, z) || 1;
      runner.faceX = x / len;
      runner.faceZ = z / len;
    }
  }

  // Set the carried NPC down in a free neighbouring cell: the one you're
  // facing first, then the others — but a cell inside the shape beats one
  // outside, whichever way you face. No room → it stays on your shoulders.
  private placeNpc(runner: Runner): boolean {
    if (!this.canMove()) return false;
    const npc = this.npcs.get(runner.carrying);
    if (!npc || npc.state !== NPC_CARRIED) return false;
    const occ = this.occupancy();
    const cx = Math.floor(runner.x);
    const cz = Math.floor(runner.z);
    const ahead: [number, number] =
      Math.abs(runner.faceX) >= Math.abs(runner.faceZ)
        ? [Math.sign(runner.faceX) || 1, 0]
        : [0, Math.sign(runner.faceZ) || 1];
    const dirs: [number, number][] = [ahead];
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (d[0] !== ahead[0] || d[1] !== ahead[1]) dirs.push([d[0], d[1]]);
    }
    const options = dirs
      .map(([dx, dz]) => [cx + dx, cz + dz] as [number, number])
      .filter(([tx, tz]) => this.freeCell(occ, tx, tz));
    if (options.length === 0) return false;
    const shape = this.shape;
    const inside = shape ? options.filter(([tx, tz]) => shapeHasCell(shape, tx, tz)) : [];
    const [tx, tz] = inside.length > 0 ? inside[0] : options[0];
    npc.state = NPC_WAITING;
    npc.carrier = 0;
    npc.x = tx + 0.5;
    npc.z = tz + 0.5;
    runner.carrying = 0;
    this.ctx.emitMe(runner.slot);
    return true;
  }

  private canMove(): boolean {
    return (
      this.phase === 'play' && (this.roundPhase === 'form' || this.roundPhase === 'rise')
    );
  }

  private inside(x: number, z: number): boolean {
    return this.shape !== null && shapeContains(this.shape, x, z);
  }

  private aliveRunners(): Runner[] {
    return [...this.runners.values()].filter((r) => r.state === TETRIS_ALIVE);
  }

  private liveNpcs(): Npc[] {
    return [...this.npcs.values()].filter((n) => n.state === NPC_WAITING || n.state === NPC_CARRIED);
  }

  // ------------------------------------------------------------- rounds

  private beginRound() {
    this.round++;
    this.roundPhase = 'form';
    this.pt = 0;
    this.timeLimit = Math.max(MIN_TIMER, FIRST_TIMER - (this.round - 1) * TIMER_STEP);
    const alive = this.aliveRunners();
    for (const r of alive) r.hurried = false;
    // Lost NPCs turn up outside the safe zone — more of them every round —
    // but never so many that the crowd plus NPCs couldn't fit a shape.
    if (this.round >= NPC_FROM_ROUND) {
      const live = this.liveNpcs().length;
      const cap = Math.ceil(alive.length * 0.6) + 1;
      // One more per round, on top of a crowd-sized base wave.
      const wave = Math.max(1, Math.round(alive.length / 8)) + (this.round - NPC_FROM_ROUND);
      const spawn = Math.min(wave, Math.max(0, cap - live));
      // The previous shape is still down while the wall rises; NPCs spawn
      // clear of the NEXT shape, so pick the shape first with a headcount
      // that includes them.
      this.shape = this.pickShape(alive.length + live + spawn);
      for (let i = 0; i < spawn; i++) this.spawnNpc();
    } else {
      this.shape = this.pickShape(alive.length + this.liveNpcs().length);
    }
    this.lastCrushed = [[], []];
    for (const r of alive) {
      this.ctx.buzz(r.slot, 'go');
      this.ctx.emitMe(r.slot);
    }
  }

  // One cell per head is the floor (cells are exclusive); early rounds
  // add 40% breathing room, shrinking to about an eighth by round 7.
  private pickShape(heads: number): TetrisShape {
    const slack = Math.max(1, Math.ceil(heads * Math.max(0.12, 0.4 - (this.round - 1) * 0.05)));
    return generateShape(this.fieldW, this.fieldD, Math.max(3, heads + slack));
  }

  private spawnNpc() {
    const shape = this.shape;
    const occ = this.occupancy();
    // Outside the shape's box with a cell of clearance — genuinely
    // stranded, not a free rescue. Fall back to merely outside, then to
    // anywhere free.
    const clear = (cx: number, cz: number) =>
      !shape ||
      cx < shape.x0 - 1 ||
      cx > shape.x0 + shape.w ||
      cz < shape.z0 - 1 ||
      cz > shape.z0 + shape.h;
    let cell = this.randomFreeCell(occ, clear);
    if (cell && shape && shapeHasCell(shape, cell[0], cell[1])) {
      cell = this.randomFreeCell(occ, (cx, cz) => !shapeHasCell(shape, cx, cz));
    }
    if (!cell) return;
    const id = this.nextNpcId++;
    this.npcs.set(id, { id, x: cell[0] + 0.5, z: cell[1] + 0.5, state: NPC_WAITING, carrier: 0 });
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

  // ------------------------------------------------------------ movement

  // Continuous motion on an exclusive grid. Each player advances; a step
  // that crosses into another cell must find it free — or barge whoever is
  // there aside (sideways if there's room, else straight ahead, chain and
  // all). A free-handed player stepping onto a waiting NPC scoops it up.
  private integrate(dt: number) {
    const k = 1 - Math.exp(-ACCEL * dt);
    const occ = this.occupancy();
    // Random order each tick so no slot always wins a head-on contest.
    const movers = this.aliveRunners();
    for (let i = movers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [movers[i], movers[j]] = [movers[j], movers[i]];
    }
    for (const r of movers) {
      r.vx += (r.joyX * SPEED - r.vx) * k;
      r.vz += (r.joyZ * SPEED - r.vz) * k;
      const nx = this.clampX(r.x + r.vx * dt);
      const nz = this.clampZ(r.z + r.vz * dt);
      // Axis by axis so a diagonal step never skips a cell.
      this.stepAxis(r, occ, nx, r.z, 0);
      this.stepAxis(r, occ, r.x, nz, 1);
    }
    // Carried NPCs ride their carrier.
    for (const n of this.npcs.values()) {
      if (n.state !== NPC_CARRIED) continue;
      const c = this.runners.get(n.carrier);
      if (c) {
        n.x = c.x;
        n.z = c.z;
      }
    }
  }

  // Move r toward (nx, nz) along one axis (0 = x, 1 = z), resolving the
  // cell boundary if the step crosses one.
  private stepAxis(r: Runner, occ: Map<number, Occupant>, nx: number, nz: number, axis: 0 | 1) {
    const ocx = Math.floor(r.x);
    const ocz = Math.floor(r.z);
    const ncx = Math.floor(nx);
    const ncz = Math.floor(nz);
    if (ncx === ocx && ncz === ocz) {
      r.x = nx;
      r.z = nz;
      return;
    }
    const dx = Math.sign(ncx - ocx);
    const dz = Math.sign(ncz - ocz);
    const key = this.cellKey(ncx, ncz);
    const who = occ.get(key);
    let allowed = !who;
    if (who && who.kind === 'n' && r.carrying === 0) {
      // Scoop the NPC up on the way in.
      const n = who.n;
      n.state = NPC_CARRIED;
      n.carrier = r.slot;
      r.carrying = n.id;
      occ.delete(key);
      this.ctx.buzz(r.slot, 'pickup');
      this.ctx.emitMe(r.slot);
      allowed = true;
    } else if (who) {
      allowed = this.clock - r.shovedAt >= SHOVE_STUN && this.barge(occ, ncx, ncz, dx, dz);
    }
    if (!allowed) {
      // Blocked: stop at the boundary of the current cell.
      if (axis === 0) {
        r.x = dx > 0 ? ocx + 0.999 : ocx + 0.001;
        r.vx = 0;
      } else {
        r.z = dz > 0 ? ocz + 0.999 : ocz + 0.001;
        r.vz = 0;
      }
      return;
    }
    occ.delete(this.cellKey(ocx, ocz));
    r.x = nx;
    r.z = nz;
    occ.set(key, { kind: 'p', r });
  }

  // Clear cell (cx, cz) for someone arriving along (dx, dz): the occupant
  // stumbles sideways into a free cell if one exists, otherwise everyone
  // ahead in line gets shunted one cell forward (up to SHOVE_CHAIN), and
  // if the line runs into the field edge nobody moves. Returns whether the
  // cell is now free.
  private barge(occ: Map<number, Occupant>, cx: number, cz: number, dx: number, dz: number): boolean {
    const sides: [number, number][] = dx !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    if (Math.random() < 0.5) sides.reverse();
    // Someone standing inside the shape stumbles toward the side that
    // keeps them inside when there is one — a barge should cost the
    // barger's victim their cell, not their life.
    const shape = this.shape;
    if (shape && shapeHasCell(shape, cx, cz)) {
      sides.sort((a, b) => Number(shapeHasCell(shape, cx + b[0], cz + b[1])) - Number(shapeHasCell(shape, cx + a[0], cz + a[1])));
    }
    for (const [sx, sz] of sides) {
      if (this.freeCell(occ, cx + sx, cz + sz)) {
        this.shift(occ, cx, cz, sx, sz);
        return true;
      }
    }
    // Forward chain: find the first free cell down the line.
    let n = 0;
    let tx = cx;
    let tz = cz;
    while (occ.has(this.cellKey(tx, tz))) {
      tx += dx;
      tz += dz;
      n++;
      if (!this.inField(tx, tz) || n > SHOVE_CHAIN) return false;
    }
    // Shift from the far end back so no occupant lands on another.
    for (let i = n - 1; i >= 0; i--) {
      this.shift(occ, cx + dx * i, cz + dz * i, dx, dz);
    }
    return true;
  }

  // Move whoever stands in (cx, cz) one cell along (dx, dz).
  private shift(occ: Map<number, Occupant>, cx: number, cz: number, dx: number, dz: number) {
    const key = this.cellKey(cx, cz);
    const who = occ.get(key);
    if (!who) return;
    occ.delete(key);
    if (who.kind === 'p') {
      who.r.x = this.clampX(who.r.x + dx);
      who.r.z = this.clampZ(who.r.z + dz);
      who.r.shovedAt = this.clock;
      this.ctx.buzz(who.r.slot, 'bumped');
    } else {
      who.n.x = this.clampX(who.n.x + dx);
      who.n.z = this.clampZ(who.n.z + dz);
    }
    occ.set(this.cellKey(cx + dx, cz + dz), who);
  }

  // ---------------------------------------------------------------- bots

  // Fake-player AI: head for a free spot inside the shape (spreading out,
  // with human reaction lag and a streak of laziness), fetch stranded NPCs
  // when there's time, set them down inside and go back for more — and,
  // being human, some of them WILL be outside when the wall lands.
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
        shoveSeen: -Infinity,
        wanderA: Math.random() * Math.PI * 2,
        wanderAt: 0,
      };
      this.brains.set(slot, brain);
    }
    const shape = this.shape;
    if (!shape || this.roundPhase !== 'form') return { t: 'joy', x: 0, y: 0 };
    const tLeft = this.timeLimit - this.pt;
    if (this.pt < brain.react) return { t: 'joy', x: 0, y: 0 };
    const inside = this.inside(r.x, r.z);
    // Dawdle (outside only): wander until the lazy fraction of the timer
    // is spent.
    if (!inside && this.pt < this.timeLimit * brain.lazy * 0.35 && !r.carrying) {
      if (this.clock >= brain.wanderAt) {
        brain.wanderA += (Math.random() - 0.5) * 2;
        brain.wanderAt = this.clock + 0.6 + Math.random();
      }
      return this.joyToward(r, r.x + Math.cos(brain.wanderA), r.z + Math.sin(brain.wanderA), 0.5);
    }
    const occ = this.occupancy();
    const plan = this.planPaths(r, occ);
    // Heroics: the nearest stranded NPC (outside the shape), if the trip
    // there and back into the shape fits in the time left.
    if (brain.hero > 0.35) {
      let best: Npc | null = null;
      let bestD = Infinity;
      for (const n of this.npcs.values()) {
        if (n.state !== NPC_WAITING || this.inside(n.x, n.z)) continue;
        const d = Math.hypot(n.x - r.x, n.z - r.z);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) {
        const back = this.nearestCellDist(best.x, best.z);
        const fits = (bestD + back) / SPEED + 1.5 < tLeft;
        if (fits && r.carrying && inside) {
          // Hands full and safe: set this one down and go back for more.
          return [{ t: 'place' }, { t: 'joy', x: 0, y: 0 }];
        }
        if (fits && !r.carrying) return this.joyAlong(r, plan, best.x, best.z);
      }
    }
    // Pick (and occasionally re-pick) a FREE cell inside the shape: near,
    // interior, and cheap to reach (every occupied cell on the way is a
    // barge), with a little jitter so the crowd spreads; re-pick at once
    // after being barged out of the way or when someone took the target.
    const myCell = this.cellKey(Math.floor(r.x), Math.floor(r.z));
    const targetKey = this.cellKey(Math.floor(brain.tx), Math.floor(brain.tz));
    const targetTaken = targetKey !== myCell && occ.has(targetKey);
    const barged = r.shovedAt > brain.shoveSeen;
    // Safe is safe: a bot standing inside holds its cell — no shuffling
    // to a "nicer" one, which only barges someone else out.
    if (inside && brain.targetRound === this.round && !barged) {
      brain.tx = Math.floor(r.x) + 0.5;
      brain.tz = Math.floor(r.z) + 0.5;
      return { t: 'joy', x: 0, y: 0 };
    }
    if (brain.targetRound !== this.round || this.clock >= brain.retargetAt || targetTaken || barged) {
      brain.targetRound = this.round;
      brain.shoveSeen = r.shovedAt;
      brain.retargetAt = this.clock + 1 + Math.random() * 1.5;
      let best: [number, number] | null = null;
      let bestScore = Infinity;
      for (const [cx, cz] of shapeCells(shape)) {
        const key = this.cellKey(cx, cz);
        if (key !== myCell && occ.has(key)) continue;
        const mx = cx + 0.5;
        const mz = cz + 0.5;
        let exposed = 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!shapeHasCell(shape, cx + dc, cz + dr)) exposed++;
        }
        const trip = plan.cost.get(key) ?? 99; // steps, barges weighted in
        const score = trip + exposed * 0.45 + Math.random() * 1.2;
        if (score < bestScore) {
          bestScore = score;
          best = [mx + (Math.random() - 0.5) * 0.3, mz + (Math.random() - 0.5) * 0.3];
        }
      }
      if (best) [brain.tx, brain.tz] = best;
      else if (inside) return { t: 'joy', x: 0, y: 0 }; // full house — hold your cell
    }
    const d = Math.hypot(brain.tx - r.x, brain.tz - r.z);
    if (d < 0.12) return { t: 'joy', x: 0, y: 0 };
    return this.joyAlong(r, plan, brain.tx, brain.tz);
  }

  // Cheapest routes from the bot's cell to every cell, where every step
  // costs one and every occupied cell on the way costs BARGE_COST more —
  // so a bot barges through when the way round would be long, and walks
  // round when it's short (Dijkstra on a bucket queue: costs are small
  // integers). `prev` links each cell back toward the start.
  private planPaths(
    r: Runner,
    occ: Map<number, Occupant>,
  ): { cost: Map<number, number>; prev: Map<number, number> } {
    const start = this.cellKey(Math.floor(r.x), Math.floor(r.z));
    const cost = new Map<number, number>([[start, 0]]);
    const prev = new Map<number, number>([[start, -1]]);
    const buckets: number[][] = [[start]];
    const done = new Set<number>();
    for (let c = 0; c < buckets.length; c++) {
      const bucket = buckets[c];
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const cur = bucket[i];
        if (done.has(cur) || cost.get(cur) !== c) continue;
        done.add(cur);
        const cx = cur % 1000;
        const cz = Math.floor(cur / 1000);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.inField(nx, nz)) continue;
          const nk = this.cellKey(nx, nz);
          const nc = c + 1 + (occ.has(nk) ? BARGE_COST : 0);
          if (nc >= (cost.get(nk) ?? Infinity)) continue;
          cost.set(nk, nc);
          prev.set(nk, cur);
          (buckets[nc] ??= []).push(nk);
        }
      }
    }
    return { cost, prev };
  }

  // Steer toward a point along the planned route. Bots re-plan only every
  // ~180ms, so at full speed they'd overshoot a waypoint by most of a cell
  // — and an unplanned cell entry is a barge: cross into the next cell
  // squarely (centre up on the cross axis first; a diagonal cut clips the
  // corner of a third cell) and ease into every waypoint.
  private joyAlong(
    r: Runner,
    plan: { cost: Map<number, number>; prev: Map<number, number> },
    tx: number,
    tz: number,
  ): InputPayload {
    const sx = Math.floor(r.x);
    const sz = Math.floor(r.z);
    const gx = Math.floor(tx);
    const gz = Math.floor(tz);
    const ease = (dist: number, span: number) => Math.min(1, dist / span);
    if (sx === gx && sz === gz) {
      return this.joyToward(r, tx, tz, ease(Math.hypot(tx - r.x, tz - r.z), 0.5));
    }
    const start = this.cellKey(sx, sz);
    const goal = this.cellKey(gx, gz);
    if (!plan.prev.has(goal)) return this.joyToward(r, tx, tz, 1);
    let step = goal;
    while (plan.prev.get(step) !== start) step = plan.prev.get(step)!;
    const nx = step % 1000;
    const nz = Math.floor(step / 1000);
    const cx = sx + 0.5;
    const cz = sz + 0.5;
    const centre = (dist: number) => Math.max(0.15, Math.min(0.5, dist * 0.6));
    if (nx !== sx) {
      const off = Math.abs(r.z - cz);
      if (off > 0.22) return this.joyToward(r, r.x, cz, centre(off));
      return this.joyToward(r, nx + 0.5, cz, ease(Math.abs(nx + 0.5 - r.x), 0.9));
    }
    const off = Math.abs(r.x - cx);
    if (off > 0.22) return this.joyToward(r, cx, r.z, centre(off));
    return this.joyToward(r, cx, nz + 0.5, ease(Math.abs(nz + 0.5 - r.z), 0.9));
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
