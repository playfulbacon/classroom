import {
  MEDUSA_FALLEN,
  MEDUSA_FINISHED,
  MEDUSA_RUNNING,
  MEDUSA_STONE,
  type GamePhase,
  type InputPayload,
  type MedusaGazeState,
  type MedusaPlayerTuple,
  type MedusaSnapshot,
  type MeState,
} from '../../../shared/protocol';
import type { GameCtx, GameModule } from './types';

const TICK_MS = 1000 / 20;
const COUNTDOWN = 3;
const TIME_LIMIT = 90; // seconds; at timeout Medusa's final gaze petrifies everyone
const LENGTH = 24; // columns along the race axis; last column is the finish
const GRACE = 0.3; // seconds after red locks during which hops are forgiven
const EYES_GRACE = 0.6; // longer: time to physically close eyes + detection lag
const EYES_FRESH = 1.5; // seconds before eye reports go stale → classic rules
const HOP_COOLDOWN = 0.18; // bounds tap-mash speed
const PING_COOLDOWN = 2;
const TURN_TIME = 0.8; // turning / returning duration (the audible warning)

type PlayerState =
  | typeof MEDUSA_RUNNING
  | typeof MEDUSA_STONE
  | typeof MEDUSA_FINISHED
  | typeof MEDUSA_FALLEN;

interface Runner {
  slot: number;
  col: number;
  lane: number;
  state: PlayerState;
  lastHopAt: number;
  lastPingAt: number;
  // Eye mode (camera): latest on-device report from this player's phone.
  eyesOpen: boolean;
  faceSeen: boolean;
  eyesAt: number; // t of the latest report; -Infinity = never reported
}

interface BotBrain {
  reaction: number; // seconds of lag noticing gaze changes
  risk: number; // 0..1 — how far into red this bot dares to sneak hops
  eagerness: number; // probability of hopping on a given green think-tick
}

export class Medusa implements GameModule {
  readonly id = 'medusa' as const;
  private readonly ctx: GameCtx;
  private readonly runners = new Map<number, Runner>();
  private readonly brains = new Map<number, BotBrain>();
  private lanes = 20;
  private startCols = 2;
  private pits = new Set<number>(); // lane * LENGTH + col
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private t = 0;
  private gaze: MedusaGazeState = 'green';
  private gazeUntil = 0; // t at which the current gaze state ends
  private redSince = 0;
  private finished: number[] = [];
  private pings: number[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
  }

  private pitKey(col: number, lane: number): number {
    return lane * LENGTH + col;
  }

  start() {
    const slots = this.ctx
      .slots()
      .map((s) => s.slot)
      .sort((a, b) => a - b);
    // Enough lanes that the start zone averages <=2 per cell but the field
    // never gets absurdly deep for small groups.
    this.lanes = Math.min(24, Math.max(12, Math.ceil(slots.length / 4) * 2));
    this.startCols = Math.max(2, Math.ceil(slots.length / this.lanes / 2));
    this.generatePits();
    // Seating-chart start: numbers run in order down the first start column,
    // then the next, so students find themselves like finding a seat.
    slots.forEach((slot, i) => {
      this.runners.set(slot, {
        slot,
        col: Math.floor(i / this.lanes) % this.startCols,
        lane: i % this.lanes,
        state: MEDUSA_RUNNING,
        lastHopAt: -1,
        lastPingAt: -PING_COOLDOWN,
        eyesOpen: true,
        faceSeen: false,
        eyesAt: -Infinity,
      });
    });
    this.scheduleGaze('green', this.greenDuration());
    this.interval = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  // ~15% pits, none on 3-4 carved monotone safe paths, capped per column so
  // no column becomes a wall; the start zone and the last two columns stay
  // clear.
  private generatePits() {
    const safe = new Set<number>();
    const paths = 3 + Math.floor(Math.random() * 2);
    for (let p = 0; p < paths; p++) {
      let lane = Math.floor(Math.random() * this.lanes);
      for (let col = 0; col < LENGTH; col++) {
        safe.add(this.pitKey(col, lane));
        lane = Math.min(
          this.lanes - 1,
          Math.max(0, lane + (Math.floor(Math.random() * 3) - 1)),
        );
        safe.add(this.pitKey(Math.min(col + 1, LENGTH - 1), lane));
      }
    }
    this.pits = new Set();
    const firstPitCol = this.startCols + 1;
    for (let col = firstPitCol; col <= LENGTH - 3; col++) {
      let inCol = 0;
      const cap = Math.floor(this.lanes * 0.35);
      for (let lane = 0; lane < this.lanes; lane++) {
        if (inCol >= cap) break;
        if (safe.has(this.pitKey(col, lane))) continue;
        if (Math.random() < 0.18) {
          this.pits.add(this.pitKey(col, lane));
          inCol++;
        }
      }
    }
  }

  private greenDuration(): number {
    // Green windows shrink as the round drags on — pressure builds.
    const squeeze = Math.max(0.55, 1 - this.t / 180);
    return (3.5 + Math.random() * 3.5) * squeeze;
  }

  private scheduleGaze(state: MedusaGazeState, duration: number) {
    this.gaze = state;
    this.gazeUntil = this.t + duration;
    if (state === 'red') this.redSince = this.t;
  }

  onJoin(slot: number) {
    if (this.phase === 'over' || this.runners.has(slot)) return;
    this.runners.set(slot, {
      slot,
      col: 0,
      lane: (slot - 1) % this.lanes,
      state: MEDUSA_RUNNING,
      lastHopAt: -1,
      lastPingAt: -PING_COOLDOWN,
      eyesOpen: true,
      faceSeen: false,
      eyesAt: -Infinity,
    });
  }

  // Eye rules apply only while this runner's phone streams fresh face data;
  // a denied/covered/lost camera silently reverts them to classic rules, so
  // hiding the lens never helps.
  private eyeModeActive(runner: Runner): boolean {
    return (
      this.ctx.options.medusaEyes &&
      runner.faceSeen &&
      this.t - runner.eyesAt < EYES_FRESH
    );
  }

  input(slot: number, payload: InputPayload) {
    const runner = this.runners.get(slot);
    if (!runner) return;
    if (payload.t === 'ping') {
      if (this.t - runner.lastPingAt < PING_COOLDOWN) return;
      runner.lastPingAt = this.t;
      this.pings.push(slot);
      return;
    }
    if (payload.t === 'eyes') {
      if (!this.ctx.options.medusaEyes) return; // toggle off → inert
      runner.eyesOpen = payload.open === true;
      runner.faceSeen = payload.seen === true;
      runner.eyesAt = this.t;
      return;
    }
    if (payload.t !== 'hop') return;
    if (this.phase !== 'play' || runner.state !== MEDUSA_RUNNING) return;
    if (this.t - runner.lastHopAt < HOP_COOLDOWN) return;
    runner.lastHopAt = this.t;

    // Medusa's rule during red (past the grace window):
    // - eye mode: LOOKING is the crime — eyes-closed players may keep moving
    //   blind (the open-eyed are petrified by the tick loop anyway);
    // - classic: any hop petrifies you where you stand — it never lands.
    if (this.gaze === 'red' && this.t - this.redSince > GRACE) {
      if (this.eyeModeActive(runner)) {
        if (runner.eyesOpen) {
          this.petrify(runner);
          return;
        }
        // eyes shut — brave the blind hop
      } else {
        this.petrify(runner);
        return;
      }
    }

    let { col, lane } = runner;
    if (payload.d === 'f') col += 1;
    else if (payload.d === 'b') col -= 1;
    else if (payload.d === 'l') lane -= 1;
    else if (payload.d === 'r') lane += 1;
    else return;
    col = Math.max(0, Math.min(LENGTH - 1, col));
    lane = Math.max(0, Math.min(this.lanes - 1, lane));
    if (col === runner.col && lane === runner.lane) return;
    runner.col = col;
    runner.lane = lane;

    if (this.pits.has(this.pitKey(col, lane))) {
      runner.state = MEDUSA_FALLEN;
      this.ctx.buzz(slot, 'eliminated');
      this.ctx.emitMe(slot);
      this.checkEnd();
      return;
    }
    if (col === LENGTH - 1) {
      runner.state = MEDUSA_FINISHED;
      this.finished.push(slot);
      this.ctx.buzz(slot, 'locked');
      this.ctx.emitMe(slot);
      this.checkEnd();
    }
  }

  private buzzRunners(type: 'go' | 'bumped') {
    for (const r of this.runners.values()) {
      if (r.state === MEDUSA_RUNNING) this.ctx.buzz(r.slot, type);
    }
  }

  private petrify(runner: Runner) {
    runner.state = MEDUSA_STONE;
    this.ctx.buzz(runner.slot, 'eliminated');
    this.ctx.emitMe(runner.slot);
    this.checkEnd();
  }

  private checkEnd() {
    if (this.phase !== 'play') return;
    for (const r of this.runners.values()) {
      if (r.state === MEDUSA_RUNNING) return;
    }
    this.phase = 'over';
    for (const r of this.runners.values()) this.ctx.emitMe(r.slot);
  }

  // Fake-player AI: sprint on green, freeze when she turns (with human-like
  // reaction lag), dodge pits, and — for the risk-takers — sneak hops into
  // early red. Some bots WILL become statues; that's the show.
  botInput(slot: number): InputPayload | null {
    if (this.phase !== 'play') return null;
    const runner = this.runners.get(slot);
    if (!runner || runner.state !== MEDUSA_RUNNING) return null;
    let brain = this.brains.get(slot);
    if (!brain) {
      brain = {
        reaction: 0.15 + Math.random() * 0.35,
        risk: Math.random(),
        eagerness: 0.55 + Math.random() * 0.45,
      };
      this.brains.set(slot, brain);
    }
    // What the bot believes: it notices gaze changes `reaction` late.
    const sinceChange = this.gazeUntil - this.t; // unused for belief; use timers below
    void sinceChange;
    const dangerKnown =
      (this.gaze === 'turning' && this.gazeUntil - this.t < TURN_TIME - brain.reaction) ||
      this.gaze === 'red';
    if (dangerKnown) {
      // Risk-takers sneak hops in the first moments of red (grace + nerve).
      const sneak =
        this.gaze === 'red' &&
        this.t - this.redSince < GRACE * 0.8 + brain.risk * 0.35 &&
        Math.random() < brain.risk * 0.5;
      if (!sneak) return null;
    }
    if (Math.random() > brain.eagerness) return null;
    // BFS to the finish around pits — greedy dodging can trap a runner in a
    // pit pocket forever; the generated fields are always solvable.
    return { t: 'hop', d: this.pathStep(runner.col, runner.lane) };
  }

  private pathStep(fromCol: number, fromLane: number): 'f' | 'l' | 'r' | 'b' {
    const key = (c: number, l: number) => l * LENGTH + c;
    const start = key(fromCol, fromLane);
    const prev = new Map<number, number>();
    prev.set(start, -1);
    const queue = [start];
    while (queue.length > 0) {
      const cell = queue.shift()!;
      const c = cell % LENGTH;
      const l = Math.floor(cell / LENGTH);
      if (c === LENGTH - 1) {
        let cur = cell;
        for (;;) {
          const p = prev.get(cur)!;
          if (p === start) break;
          if (p === -1) return 'f'; // already at the finish column
          cur = p;
        }
        const dc = (cur % LENGTH) - fromCol;
        const dl = Math.floor(cur / LENGTH) - fromLane;
        if (dc === 1) return 'f';
        if (dc === -1) return 'b';
        return dl === -1 ? 'l' : 'r';
      }
      for (const [dc, dl] of [[1, 0], [0, -1], [0, 1], [-1, 0]] as const) {
        const nc = c + dc;
        const nl = l + dl;
        if (nc < 0 || nc >= LENGTH || nl < 0 || nl >= this.lanes) continue;
        const nk = key(nc, nl);
        if (prev.has(nk) || this.pits.has(nk)) continue;
        prev.set(nk, cell);
        queue.push(nk);
      }
    }
    return 'f'; // fully walled (cannot happen on generated fields)
  }

  personal(slot: number): Partial<MeState> {
    const runner = this.runners.get(slot);
    if (!runner) return { waiting: true };
    const states = ['running', 'stone', 'finished', 'fallen'] as const;
    const me: Partial<MeState> = {
      medusaState: states[runner.state],
      col: runner.col,
      fieldLength: LENGTH,
      eyeMode: this.ctx.options.medusaEyes,
    };
    const rank = this.finished.indexOf(slot);
    if (rank !== -1) me.placement = rank + 1;
    return me;
  }

  private tick(dt: number) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'play';
        for (const r of this.runners.values()) this.ctx.buzz(r.slot, 'go');
      }
      this.emitSnapshot();
      return;
    }
    if (this.phase === 'over') {
      this.emitSnapshot();
      return;
    }

    this.t += dt;

    // Gaze state machine. Turning/green transitions buzz every running phone
    // so eyes-closed players get a non-visual cue (the stage's speakers
    // already announce it to the room, so nothing secret leaks).
    if (this.t >= this.gazeUntil) {
      if (this.gaze === 'green') {
        this.scheduleGaze('turning', TURN_TIME);
        this.buzzRunners('bumped');
      } else if (this.gaze === 'turning') {
        this.scheduleGaze('red', 2 + Math.random() * 2.5);
      } else if (this.gaze === 'red') {
        this.scheduleGaze('returning', TURN_TIME);
      } else {
        this.scheduleGaze('green', this.greenDuration());
        this.buzzRunners('go');
      }
    }

    // Eye mode: during red, open eyes petrify — even standing still.
    if (this.gaze === 'red' && this.t - this.redSince > EYES_GRACE) {
      for (const r of this.runners.values()) {
        if (r.state !== MEDUSA_RUNNING) continue;
        if (this.eyeModeActive(r) && r.eyesOpen) this.petrify(r);
      }
    }

    // Time up: her final gaze sweeps the whole field.
    if (this.t >= TIME_LIMIT) {
      for (const r of this.runners.values()) {
        if (r.state === MEDUSA_RUNNING) {
          r.state = MEDUSA_STONE;
          this.ctx.buzz(r.slot, 'eliminated');
          this.ctx.emitMe(r.slot);
        }
      }
      this.phase = 'over';
      for (const r of this.runners.values()) this.ctx.emitMe(r.slot);
    }

    this.emitSnapshot();
  }

  private emitSnapshot() {
    const players: MedusaPlayerTuple[] = [...this.runners.values()].map((r) => [
      r.slot,
      r.col,
      r.lane,
      r.state,
      this.eyeModeActive(r) ? (r.eyesOpen ? 0 : 1) : -1,
    ]);
    const snapshot: MedusaSnapshot = {
      kind: 'medusa',
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      t: round1(this.t),
      timeLimit: TIME_LIMIT,
      length: LENGTH,
      lanes: this.lanes,
      pits: [...this.pits].map((k) => [k % LENGTH, Math.floor(k / LENGTH)]),
      gaze: { state: this.gaze, tLeft: round1(Math.max(0, this.gazeUntil - this.t)) },
      players,
      pings: this.pings,
      finished: this.finished,
      aliveCount: [...this.runners.values()].filter((r) => r.state === MEDUSA_RUNNING)
        .length,
    };
    this.pings = [];
    this.ctx.emitStage(snapshot);
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
