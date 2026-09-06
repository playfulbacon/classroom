import {
  GZ_CAUGHT,
  GZ_CLASSIC,
  GZ_CLOSED,
  GZ_SHIELD,
  GZ_UNKNOWN,
  MEDUSA_FINISHED,
  MEDUSA_RUNNING,
  MEDUSA_STONE,
  type GamePhase,
  type InputPayload,
  type MedusaCrumbleTuple,
  type MedusaFieldMsg,
  type MedusaGazeState,
  type MedusaPlatformTuple,
  type MedusaPlayerTuple,
  type MedusaSnapshot,
  type MeState,
} from '../../../shared/protocol';
import type { GameCtx, GameModule } from './types';
import { generateField, type MedusaField } from './medusaField';

const TICK_MS = 1000 / 20;
const COUNTDOWN = 3;
const TIME_LIMIT = 90; // seconds; at timeout Medusa's final gaze petrifies everyone
const LENGTH = 24; // columns along the race axis; last column is the finish
const GRACE = 0.3; // classic: seconds after red locks during which hops are forgiven
const HOP_COOLDOWN = 0.18; // bounds tap-mash speed
const PING_COOLDOWN = 2;
const TURN_TIME = 0.8; // turning / returning duration (the audible warning)
const PLATFORM_SPEED = 1.6; // cells/s a ferry shuttles across its chasm
const ALIGN_EPS = 0.35; // |pos - col| within which a ferry is boardable
const CRUMBLE_COLLAPSE_DELAY = 0.6; // s after a cracked cell is vacated

// --- v2 gaze meter (eye mode) -------------------------------------------
// Petrification is a process: her gaze fills a per-player meter, safety
// drains it, full = statue. Only high-confidence CAUGHT frames raise the
// stone tiers that slow you — uncertainty kills slowly but never slows.
const RED_START_GRACE = 0.8; // meter frozen at the start of each red (fairness)
const DROPOUT_GRACE = 0.5; // brief tracking dropouts keep the previous state
const CLOSED_LINGER = 1.5; // eyes-closed heads drift out of frame — linger longer
const GAZE_FRESH = 0.8; // reports older than this are UNKNOWN
const CAUGHT_CONF = 0.6; // below this, a caught report degrades to UNKNOWN
const FILL_CAUGHT = 1 / 1.0; // meter/s while her gaze meets open eyes
const FILL_UNKNOWN = 1 / 2.5; // the camera-hider's slow death
const DRAIN_SAFE = 1 / 1.5; // shield/closed recovery during red
const DRAIN_GREEN = 1 / 15; // slow redemption while she looks away
const TIER_ENTER = [0.4, 0.7]; // meter thresholds that raise tiers 1, 2
const TIER_EXIT = [0.3, 0.6]; // hysteresis exits
const TIER_COOLDOWN_MULT = [1, 2, 4]; // hop cooldown multiplier per tier
const SHIELD_SLOW = 2.5; // extra cooldown mult while navigating by shield in red
const CONE_HALF = Math.PI / 4; // half-angle of her gaze cone
const SWEEP_PERIOD = 3.2; // seconds per full sweep oscillation
const OCCL_BUCKET = Math.PI / 90; // 2° statue-shadow buckets

type PlayerState =
  | typeof MEDUSA_RUNNING
  | typeof MEDUSA_STONE
  | typeof MEDUSA_FINISHED;

interface Runner {
  slot: number;
  col: number;
  lane: number;
  state: PlayerState;
  lastHopAt: number;
  lastPingAt: number;
  ride: number | null; // platform id being ridden across a chasm
  // v2 gaze state (eye mode): latest phone report + derived meter machine.
  gz: number; // latest raw GZ_* report
  gzConf: number; // its confidence 0..1
  gzAt: number; // t of the latest report; -Infinity = never reported
  eff: number; // effective GZ_* after freshness/grace rules (tick-derived)
  lastSafe: number; // last SHIELD/CLOSED actually seen
  lastSafeAt: number;
  unknownSince: number; // -1 while reports are flowing
  meter: number; // 0..1 death meter — full = statue
  tier: number; // 0..2 stone tier (3 IS the statue, carried by state)
}

interface Platform {
  id: number;
  lane: number;
  c0: number;
  c1: number;
  pos: number; // continuous column position within [c0, c1]
  dir: 1 | -1;
}

interface BotBrain {
  reaction: number; // seconds of lag noticing gaze changes
  risk: number; // 0..1 — how far into red this bot dares to sneak hops
  eagerness: number; // probability of hopping on a given green think-tick
  // v2 gaze simulation:
  discipline: number; // 0..1 — low = lapses into CAUGHT; <0.1 = no camera at all
  closedStyle: boolean; // closes eyes (fast, blind) vs shield (slow, sighted)
  lapseUntil: number; // t until which this bot is staring at the big screen
}

export class Medusa implements GameModule {
  readonly id = 'medusa' as const;
  private readonly ctx: GameCtx;
  private readonly runners = new Map<number, Runner>();
  private readonly brains = new Map<number, BotBrain>();
  private lanes = 20;
  private startCols = 2;
  private pits = new Set<number>(); // lane * LENGTH + col (incl. chasm bands)
  private field: MedusaField | null = null;
  private platforms: Platform[] = [];
  private crumbleStage = new Map<number, 0 | 1 | 2>(); // every crumble cell
  private crumbleVacatedAt = new Map<number, number>(); // cracked → empty since t
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private t = 0;
  private gaze: MedusaGazeState = 'green';
  private gazeUntil = 0; // t at which the current gaze state ends
  private redSince = 0;
  private finished: number[] = [];
  private pings: number[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  // v2: statue occlusion as an angular shadow map from Medusa's eye —
  // shadow[bucket] = distance of the nearest (stationary) statue there.
  private shadow: Float64Array | null = null;
  private shadowDirty = true;
  private sweepMax = 0.6; // sweep amplitude, set from field geometry in start()

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
    this.field = generateField(LENGTH, this.lanes, this.startCols);
    this.pits = this.field.pits;
    for (const k of this.field.crumble) this.crumbleStage.set(k, 0);
    this.platforms = this.field.platforms.map((p) => ({
      id: p.id,
      lane: p.lane,
      c0: p.c0,
      c1: p.c1,
      pos: p.c0 + p.phase * (p.c1 - p.c0),
      dir: Math.random() < 0.5 ? 1 : -1,
    }));
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
        ride: null,
        gz: GZ_UNKNOWN,
        gzConf: 0,
        gzAt: -Infinity,
        eff: GZ_UNKNOWN,
        lastSafe: GZ_UNKNOWN,
        lastSafeAt: -Infinity,
        unknownSince: -1,
        meter: 0,
        tier: 0,
      });
      if (!this.ctx.isBot(slot)) this.sendField(slot);
    });
    // Her eye sits past the finish; the widest angle any cell subtends sets
    // how far the gaze cone needs to sweep.
    const maxCorner = Math.atan2((this.lanes - 1) / 2, 2.6);
    this.sweepMax = Math.max(0.25, maxCorner - CONE_HALF / 2);
    this.scheduleGaze('green', this.greenDuration());
    this.interval = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  // Static layout for the phone's shield view — sent once, never streamed.
  private sendField(slot: number) {
    const msg: MedusaFieldMsg = {
      length: LENGTH,
      lanes: this.lanes,
      pits: [...this.pits].map((k) => [k % LENGTH, Math.floor(k / LENGTH)]),
      crumble: [...this.crumbleStage.keys()].map((k) => [
        k % LENGTH,
        Math.floor(k / LENGTH),
      ]),
      platforms: this.platforms.map((p) => ({
        id: p.id,
        lane: p.lane,
        c0: p.c0,
        c1: p.c1,
      })),
    };
    this.ctx.send(slot, 'field', msg);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  // A ferry the runner could board/stand on at this cell right now.
  private platformAt(col: number, lane: number): Platform | null {
    for (const p of this.platforms) {
      if (p.lane === lane && col >= p.c0 && col <= p.c1 && Math.abs(p.pos - col) <= ALIGN_EPS) {
        return p;
      }
    }
    return null;
  }

  // Is (col, lane) somewhere a ferry ever passes (regardless of timing)?
  private onFerryRoute(col: number, lane: number): boolean {
    return this.platforms.some((p) => p.lane === lane && col >= p.c0 && col <= p.c1);
  }

  // Nothing on this field is deadly: pits, chasms and collapsed crumble
  // simply refuse the hop. A pit cell is passable only via an aligned ferry.
  private passable(col: number, lane: number): boolean {
    if (col < 0 || col >= LENGTH || lane < 0 || lane >= this.lanes) return false;
    const k = this.pitKey(col, lane);
    if (this.crumbleStage.get(k) === 2) return false;
    if (this.pits.has(k)) return this.platformAt(col, lane) !== null;
    return true;
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
      ride: null,
      gz: GZ_UNKNOWN,
      gzConf: 0,
      gzAt: -Infinity,
      eff: GZ_UNKNOWN,
      lastSafe: GZ_UNKNOWN,
      lastSafeAt: -Infinity,
      unknownSince: -1,
      meter: 0,
      tier: 0,
    });
    if (!this.ctx.isBot(slot)) this.sendField(slot);
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
    if (payload.t === 'gaze') {
      if (!this.ctx.options.medusaEyes) return; // toggle off → inert
      if (payload.s !== 0 && payload.s !== 1 && payload.s !== 2 && payload.s !== 3) return;
      runner.gz = payload.s;
      runner.gzConf = Math.max(0, Math.min(1, Number(payload.c) || 0));
      runner.gzAt = this.t;
      return;
    }
    if (payload.t !== 'hop') return;
    if (this.phase !== 'play' || runner.state !== MEDUSA_RUNNING) return;
    // Stone slows you: each tier stretches the hop cooldown, and navigating
    // by the mirrored shield during red is deliberate, careful movement.
    const shieldSlow =
      this.ctx.options.medusaEyes && this.gaze === 'red' && runner.eff === GZ_SHIELD
        ? SHIELD_SLOW
        : 1;
    const cooldown = HOP_COOLDOWN * TIER_COOLDOWN_MULT[runner.tier] * shieldSlow;
    if (this.t - runner.lastHopAt < cooldown) return;
    runner.lastHopAt = this.t;

    // Medusa's rule during red (past the grace window):
    // - v2 (eye mode): movement is NEVER the crime — petrification is the
    //   meter's job (whether her gaze meets your eyes), so the hop stands;
    // - classic: any hop petrifies you where you stand — it never lands.
    if (
      !this.ctx.options.medusaEyes &&
      this.gaze === 'red' &&
      this.t - this.redSince > GRACE
    ) {
      this.petrify(runner);
      return;
    }

    let { col, lane } = runner;
    if (payload.d === 'f') col += 1;
    else if (payload.d === 'b') col -= 1;
    else if (payload.d === 'l') lane -= 1;
    else if (payload.d === 'r') lane += 1;
    else return;
    if (col === runner.col && lane === runner.lane) return;
    // Blocked hops (bounds, pits, chasm water, collapsed ground, a ferry
    // that isn't there) are refused on the spot — nothing swallows anyone.
    if (!this.passable(col, lane)) return;
    runner.col = col;
    runner.lane = lane;
    const key = this.pitKey(col, lane);
    runner.ride = this.pits.has(key) ? this.platformAt(col, lane)!.id : null;
    if (this.crumbleStage.get(key) === 0) {
      this.crumbleStage.set(key, 1);
      this.crumbleVacatedAt.delete(key);
    }

    if (col === LENGTH - 1) {
      runner.state = MEDUSA_FINISHED;
      this.finished.push(slot);
      this.ctx.buzz(slot, 'locked');
      this.ctx.emitMe(slot);
      this.checkEnd();
      return;
    }
    if (!this.ctx.isBot(slot)) this.ctx.emitMe(slot); // phone progress bar
  }

  private buzzRunners(type: 'go' | 'bumped') {
    for (const r of this.runners.values()) {
      if (r.state === MEDUSA_RUNNING) this.ctx.buzz(r.slot, type);
    }
  }

  private petrify(runner: Runner) {
    runner.state = MEDUSA_STONE;
    this.shadowDirty = true; // a new statue casts new cover
    this.ctx.buzz(runner.slot, 'eliminated');
    this.ctx.emitMe(runner.slot);
    this.checkEnd();
  }

  // ------------------------------------------------- v2 gaze meter machine

  // Angle of a cell as seen from Medusa's eye (0 = straight down the field).
  private eyeAngle(col: number, lane: number): number {
    return Math.atan2(lane - (this.lanes - 1) / 2, LENGTH + 1.6 - col);
  }

  private eyeDist(col: number, lane: number): number {
    const dx = LENGTH + 1.6 - col;
    const dz = lane - (this.lanes - 1) / 2;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // Where her gaze points right now: sweeps across the field through red.
  private sweepDir(): number {
    if (this.gaze !== 'red') return 0;
    return this.sweepMax * Math.sin(((this.t - this.redSince) * 2 * Math.PI) / SWEEP_PERIOD);
  }

  // Statues (the stationary ones — a ferry passenger is no cover) shadow a
  // wedge of angles behind them. Rebuilt only when a statue is added.
  private rebuildShadow() {
    const buckets = Math.ceil(Math.PI / OCCL_BUCKET);
    const shadow = new Float64Array(buckets).fill(Infinity);
    for (const r of this.runners.values()) {
      if (r.state !== MEDUSA_STONE || r.ride !== null) continue;
      const phi = this.eyeAngle(r.col, r.lane);
      const d = this.eyeDist(r.col, r.lane);
      const w = Math.atan(0.45 / d);
      const b0 = Math.max(0, Math.floor((phi - w + Math.PI / 2) / OCCL_BUCKET));
      const b1 = Math.min(buckets - 1, Math.floor((phi + w + Math.PI / 2) / OCCL_BUCKET));
      for (let b = b0; b <= b1; b++) shadow[b] = Math.min(shadow[b], d);
    }
    this.shadow = shadow;
    this.shadowDirty = false;
  }

  // Is this runner in her gaze right now: inside the sweeping cone and not
  // hidden behind a statue.
  private inGaze(runner: Runner, dir: number): boolean {
    const phi = this.eyeAngle(runner.col, runner.lane);
    if (Math.abs(phi - dir) > CONE_HALF) return false;
    if (!this.shadow) return true;
    const b = Math.max(
      0,
      Math.min(this.shadow.length - 1, Math.floor((phi + Math.PI / 2) / OCCL_BUCKET)),
    );
    return this.shadow[b] >= this.eyeDist(runner.col, runner.lane) - 0.5;
  }

  // Effective gaze state after freshness and grace rules. Mutates the
  // runner's grace bookkeeping and caches the result on runner.eff.
  private effState(runner: Runner): number {
    let raw = this.t - runner.gzAt > GAZE_FRESH ? GZ_UNKNOWN : runner.gz;
    if (raw === GZ_CAUGHT && runner.gzConf < CAUGHT_CONF) raw = GZ_UNKNOWN;
    let eff: number;
    if (raw !== GZ_UNKNOWN) {
      runner.unknownSince = -1;
      if (raw === GZ_SHIELD || raw === GZ_CLOSED) {
        runner.lastSafe = raw;
        runner.lastSafeAt = this.t;
      }
      eff = raw;
    } else {
      if (runner.unknownSince < 0) runner.unknownSince = this.t;
      if (runner.lastSafe === GZ_CLOSED && this.t - runner.lastSafeAt < CLOSED_LINGER) {
        eff = GZ_CLOSED; // eyes-closed heads tilt out of frame — trust it longer
      } else if (this.t - runner.unknownSince < DROPOUT_GRACE) {
        eff = runner.eff; // brief dropout keeps the previous state
      } else {
        eff = GZ_UNKNOWN;
      }
    }
    runner.eff = eff;
    return eff;
  }

  // The heart of v2: her gaze fills each runner's meter, safety drains it,
  // full = statue. Movement never enters into it.
  private updateMeters(dt: number) {
    const red = this.gaze === 'red';
    const dir = this.sweepDir();
    if (this.shadowDirty) this.rebuildShadow();
    for (const r of this.runners.values()) {
      if (r.state !== MEDUSA_RUNNING) continue;
      const eff = this.effState(r);
      if (!red) {
        r.meter = Math.max(0, r.meter - DRAIN_GREEN * dt); // slow redemption
      } else if (this.t - this.redSince < RED_START_GRACE) {
        // fairness: the meter holds while everyone reacts to the turn
      } else if (eff === GZ_SHIELD || eff === GZ_CLOSED) {
        r.meter = Math.max(0, r.meter - DRAIN_SAFE * dt);
      } else if (this.inGaze(r, dir)) {
        r.meter += (eff === GZ_CAUGHT ? FILL_CAUGHT : FILL_UNKNOWN) * dt;
        if (r.meter >= 1) {
          r.meter = 1;
          this.petrify(r);
          continue;
        }
        // Only provable CAUGHT frames raise tiers — uncertainty kills
        // slowly but never slows.
        if (eff === GZ_CAUGHT) {
          while (r.tier < TIER_ENTER.length && r.meter >= TIER_ENTER[r.tier]) {
            r.tier++;
            this.ctx.buzz(r.slot, 'creep');
            this.ctx.emitMe(r.slot);
          }
        }
      }
      // else: unsafe but out of her cone / behind a statue — the meter holds.
      while (r.tier > 0 && r.meter < TIER_EXIT[r.tier - 1]) {
        r.tier--;
        this.ctx.emitMe(r.slot);
      }
    }
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
  botInput(slot: number): InputPayload | InputPayload[] | null {
    if (this.phase !== 'play') return null;
    const runner = this.runners.get(slot);
    if (!runner || runner.state !== MEDUSA_RUNNING) return null;
    let brain = this.brains.get(slot);
    if (!brain) {
      brain = {
        reaction: 0.15 + Math.random() * 0.35,
        risk: Math.random(),
        eagerness: 0.55 + Math.random() * 0.45,
        discipline: Math.random(),
        closedStyle: Math.random() < 0.5,
        lapseUntil: 0,
      };
      this.brains.set(slot, brain);
    }

    if (this.ctx.options.medusaEyes) {
      // v2: bots play by the meter's rules through the same input() path
      // phones use. Disciplined bots hold a safe state; the sloppy lapse
      // into CAUGHT stares; a few (discipline < 0.1) have "no camera" and
      // exercise the slow death. Movement is never the crime, so they keep
      // hopping through red — blind at full speed or by shield, slowed.
      const msgs: InputPayload[] = [];
      if (brain.discipline >= 0.1) {
        if (
          this.gaze === 'red' &&
          this.t >= brain.lapseUntil &&
          Math.random() < (1 - brain.discipline) * 0.1
        ) {
          brain.lapseUntil = this.t + 0.5 + Math.random() * 1.5;
        }
        const s = this.t < brain.lapseUntil ? GZ_CAUGHT : brain.closedStyle ? GZ_CLOSED : GZ_SHIELD;
        msgs.push({ t: 'gaze', s: s as 0 | 1 | 2 | 3, c: 0.9 });
      }
      const hop = this.botHop(runner, brain);
      if (hop) msgs.push(hop);
      return msgs.length > 0 ? msgs : null;
    }

    // Classic: sprint on green, freeze when she turns (with human-like
    // reaction lag) — and the risk-takers sneak hops into early red.
    const dangerKnown =
      (this.gaze === 'turning' && this.gazeUntil - this.t < TURN_TIME - brain.reaction) ||
      this.gaze === 'red';
    if (dangerKnown) {
      const sneak =
        this.gaze === 'red' &&
        this.t - this.redSince < GRACE * 0.8 + brain.risk * 0.35 &&
        Math.random() < brain.risk * 0.5;
      if (!sneak) return null;
    }
    return this.botHop(runner, brain);
  }

  private botHop(runner: Runner, brain: BotBrain): InputPayload | null {
    // Mid-ferry: wait for the far bank, then step off. (The ferry does the
    // work; hopping into open water is refused anyway.)
    if (runner.ride !== null) {
      return this.passable(runner.col + 1, runner.lane) ? { t: 'hop', d: 'f' } : null;
    }
    if (Math.random() > brain.eagerness) return null;
    // BFS to the finish around obstacles — greedy dodging can trap a runner
    // in a pit pocket forever; the generated fields are always solvable.
    const d = this.pathStep(runner.col, runner.lane);
    return d ? { t: 'hop', d } : null;
  }

  // First BFS step toward the finish. Blocked cells: pits/chasms off ferry
  // routes, and every crumble cell (bots stick to ground that can't vanish —
  // the carved spine guarantees they never need it). A step onto a ferry
  // route is taken only when the ferry is actually there; otherwise the bot
  // waits at the bank (returns null).
  private pathStep(fromCol: number, fromLane: number): 'f' | 'l' | 'r' | 'b' | null {
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
        const sc = cur % LENGTH;
        const sl = Math.floor(cur / LENGTH);
        // Board a ferry only when it's docked at that cell right now.
        if (this.pits.has(cur) && !this.platformAt(sc, sl)) return null;
        const dc = sc - fromCol;
        const dl = sl - fromLane;
        if (dc === 1) return 'f';
        if (dc === -1) return 'b';
        return dl === -1 ? 'l' : 'r';
      }
      for (const [dc, dl] of [[1, 0], [0, -1], [0, 1], [-1, 0]] as const) {
        const nc = c + dc;
        const nl = l + dl;
        if (nc < 0 || nc >= LENGTH || nl < 0 || nl >= this.lanes) continue;
        const nk = key(nc, nl);
        if (prev.has(nk) || this.crumbleStage.has(nk)) continue;
        if (this.pits.has(nk) && !this.onFerryRoute(nc, nl)) continue;
        prev.set(nk, cell);
        queue.push(nk);
      }
    }
    return null; // walled in (cannot happen on generated fields)
  }

  personal(slot: number): Partial<MeState> {
    const runner = this.runners.get(slot);
    if (!runner) return { waiting: true };
    const states = ['running', 'stone', 'finished'] as const;
    const me: Partial<MeState> = {
      medusaState: states[runner.state],
      col: runner.col,
      fieldLength: LENGTH,
      eyeMode: this.ctx.options.medusaEyes,
      tier: runner.tier,
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

    // Ferries shuttle their chasms; riders (statues included — a petrified
    // passenger keeps ferrying, that's the show) are carried along.
    for (const p of this.platforms) {
      p.pos += p.dir * PLATFORM_SPEED * dt;
      if (p.pos >= p.c1) {
        p.pos = p.c1;
        p.dir = -1;
      } else if (p.pos <= p.c0) {
        p.pos = p.c0;
        p.dir = 1;
      }
    }
    for (const r of this.runners.values()) {
      if (r.ride === null || r.state === MEDUSA_FINISHED) continue;
      const p = this.platforms.find((pf) => pf.id === r.ride);
      if (p) r.col = Math.round(p.pos);
    }

    // Cracked ground collapses shortly after the last foot leaves it — never
    // under someone standing on it.
    if (this.crumbleStage.size > 0) {
      const occupied = new Set<number>();
      for (const r of this.runners.values()) {
        if (r.state !== MEDUSA_FINISHED) occupied.add(this.pitKey(r.col, r.lane));
      }
      for (const [k, stage] of this.crumbleStage) {
        if (stage !== 1) continue;
        if (occupied.has(k)) {
          this.crumbleVacatedAt.delete(k);
        } else if (!this.crumbleVacatedAt.has(k)) {
          this.crumbleVacatedAt.set(k, this.t);
        } else if (this.t - this.crumbleVacatedAt.get(k)! >= CRUMBLE_COLLAPSE_DELAY) {
          this.crumbleStage.set(k, 2);
          this.crumbleVacatedAt.delete(k);
        }
      }
    }

    // v2 eye mode: the gaze meter does the petrifying, continuously.
    if (this.ctx.options.medusaEyes) this.updateMeters(dt);

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
    const eyesMode = this.ctx.options.medusaEyes;
    const players: MedusaPlayerTuple[] = [...this.runners.values()].map((r) => [
      r.slot,
      r.col,
      r.lane,
      r.state,
      eyesMode ? r.eff : GZ_CLASSIC,
      Math.round(r.meter * 100),
      r.tier,
    ]);
    // Her eyes swivel toward whoever is deepest in trouble.
    let target = 0;
    if (eyesMode && this.gaze === 'red') {
      let best = 0.05;
      for (const r of this.runners.values()) {
        if (r.state === MEDUSA_RUNNING && r.meter > best) {
          best = r.meter;
          target = r.slot;
        }
      }
    }
    const snapshot: MedusaSnapshot = {
      kind: 'medusa',
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      t: round1(this.t),
      timeLimit: TIME_LIMIT,
      length: LENGTH,
      lanes: this.lanes,
      pits: [...this.pits].map((k) => [k % LENGTH, Math.floor(k / LENGTH)]),
      platforms: this.platforms.map(
        (p): MedusaPlatformTuple => [p.id, p.lane, p.c0, p.c1, round2(p.pos)],
      ),
      crumble: [...this.crumbleStage].map(
        ([k, stage]): MedusaCrumbleTuple => [k % LENGTH, Math.floor(k / LENGTH), stage],
      ),
      eyesMode,
      gaze: {
        state: this.gaze,
        tLeft: round1(Math.max(0, this.gazeUntil - this.t)),
        dir: round2(this.sweepDir()),
        target,
      },
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
