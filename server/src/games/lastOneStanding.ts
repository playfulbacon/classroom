import type {
  GamePhase,
  InputPayload,
  LosEvent,
  LosObstacle,
  LosPlayerTuple,
  LosSnapshot,
  MeState,
} from '../../../shared/protocol';
import type { GameCtx, GameModule } from './types';

const TICK_MS = 1000 / 30;
const ARENA_R0 = 420;
const ARENA_R_MIN = 95;
const PLAYER_R = 14;
const ACCEL = 950; // thrust at full joystick deflection
const DRAG = 2.8; // v' = accel - DRAG * v  → top speed ≈ ACCEL / DRAG
const DASH_SPEED = 540;
const DASH_COOLDOWN = 2.5;
const RESTITUTION_PLAYER = 1.05;
const RESTITUTION_BUMPER = 1.5;
const RESTITUTION_BUMPER_FRENZY = 2.1;
const COUNTDOWN = 3;
const SHRINK_GRACE = 14; // seconds before the arena starts shrinking
const SHRINK_DURATION = 80; // seconds to reach minimum radius
const EVENT_FIRST_AT = 16;
const EVENT_WARN = 1.6;
const WIND_FORCE = 560;
const WIND_DURATION = 3.2;
const BUMPERS_DURATION = 8;
const FRENZY_DURATION = 6;
const FALL_MARGIN = 4; // how far the center may pass the edge before falling

interface Body {
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  joyX: number;
  joyY: number;
  alive: boolean;
  dashReadyAt: number;
  lastBumpBuzz: number;
}

interface ActiveEvent extends LosEvent {
  duration: number;
}

interface BotBrain {
  tx: number;
  ty: number;
  repickAt: number;
  nextDashAt: number;
}

export class LastOneStanding implements GameModule {
  readonly id = 'los' as const;
  private readonly ctx: GameCtx;
  private readonly bodies = new Map<number, Body>();
  private readonly obstacles: LosObstacle[] = [];
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private t = 0; // seconds since play began
  private arenaR = ARENA_R0;
  private event: ActiveEvent | null = null;
  private nextEventAt = EVENT_FIRST_AT;
  private elimOrder: number[] = [];
  private placements: number[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly brains = new Map<number, BotBrain>();

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
    this.obstacles.push({ x: 0, y: 0, r: 30 });
    const ringR = ARENA_R0 * 0.52;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      this.obstacles.push({ x: Math.cos(a) * ringR, y: Math.sin(a) * ringR, r: 24 });
    }
  }

  start() {
    const slots = this.ctx.slots();
    slots.forEach((s, i) => this.spawnBody(s.slot, i, slots.length));
    this.interval = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private spawnBody(slot: number, index: number, total: number) {
    // Spread players over 1-3 concentric rings between the bumpers.
    const rings = total > 40 ? 3 : total > 15 ? 2 : 1;
    const ring = index % rings;
    const perRing = Math.ceil(total / rings);
    const posInRing = Math.floor(index / rings);
    const radius = ARENA_R0 * (0.62 + 0.12 * ring);
    const angle = (posInRing / perRing) * Math.PI * 2 + ring * 0.35;
    this.bodies.set(slot, {
      slot,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      joyX: 0,
      joyY: 0,
      alive: true,
      dashReadyAt: 0,
      lastBumpBuzz: 0,
    });
  }

  onJoin(slot: number) {
    // Late joiners drop straight in (near the rim, moving inward feels safe).
    if (this.phase === 'over') return;
    const angle = Math.random() * Math.PI * 2;
    const radius = this.arenaR * 0.75;
    this.bodies.set(slot, {
      slot,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      joyX: 0,
      joyY: 0,
      alive: true,
      dashReadyAt: 0,
      lastBumpBuzz: 0,
    });
  }

  input(slot: number, payload: InputPayload) {
    const body = this.bodies.get(slot);
    if (!body || !body.alive || this.phase === 'over') return;
    if (payload.t === 'joy') {
      const x = clampNum(payload.x, -1, 1);
      const y = clampNum(payload.y, -1, 1);
      const mag = Math.hypot(x, y);
      if (mag > 1) {
        body.joyX = x / mag;
        body.joyY = y / mag;
      } else {
        body.joyX = x;
        body.joyY = y;
      }
    } else if (payload.t === 'dash') {
      if (this.phase !== 'play' || this.t < body.dashReadyAt) return;
      const mag = Math.hypot(clampNum(payload.x, -1, 1), clampNum(payload.y, -1, 1));
      if (mag < 0.2) return;
      const dx = clampNum(payload.x, -1, 1) / mag;
      const dy = clampNum(payload.y, -1, 1) / mag;
      body.vx += dx * DASH_SPEED;
      body.vy += dy * DASH_SPEED;
      body.dashReadyAt = this.t + DASH_COOLDOWN;
    }
  }

  // Fake-player AI: drift between random waypoints well inside the arena,
  // steer hard for the centre when the edge gets close, and occasionally
  // dash into a neighbour who's further out than we are.
  botInput(slot: number): InputPayload | null {
    const body = this.bodies.get(slot);
    if (!body || !body.alive || this.phase !== 'play') return null;
    let brain = this.brains.get(slot);
    if (!brain) {
      brain = { tx: 0, ty: 0, repickAt: 0, nextDashAt: this.t + 2 + Math.random() * 4 };
      this.brains.set(slot, brain);
    }
    if (this.t >= brain.repickAt) {
      const a = Math.random() * Math.PI * 2;
      const r = this.arenaR * (0.15 + Math.random() * 0.45);
      brain.tx = Math.cos(a) * r;
      brain.ty = Math.sin(a) * r;
      brain.repickAt = this.t + 1.2 + Math.random() * 1.8;
    }
    const myDist = Math.hypot(body.x, body.y);
    if (this.t >= brain.nextDashAt && this.t >= body.dashReadyAt) {
      brain.nextDashAt = this.t + 3 + Math.random() * 4;
      let victim: { x: number; y: number } | null = null;
      let victimDist = 130;
      for (const other of this.bodies.values()) {
        if (other === body || !other.alive) continue;
        const d = Math.hypot(other.x - body.x, other.y - body.y);
        if (d > 1 && d < victimDist && Math.hypot(other.x, other.y) > myDist) {
          victim = other;
          victimDist = d;
        }
      }
      if (victim) {
        return {
          t: 'dash',
          x: (victim.x - body.x) / victimDist,
          y: (victim.y - body.y) / victimDist,
        };
      }
    }
    // Edge panic overrides the waypoint.
    const tx = myDist > this.arenaR * 0.75 ? 0 : brain.tx;
    const ty = myDist > this.arenaR * 0.75 ? 0 : brain.ty;
    const dx = tx - body.x;
    const dy = ty - body.y;
    const mag = Math.hypot(dx, dy) || 1;
    return { t: 'joy', x: dx / mag, y: dy / mag };
  }

  personal(slot: number): Partial<MeState> {
    const body = this.bodies.get(slot);
    if (!body) return { waiting: true };
    const me: Partial<MeState> = { alive: body.alive };
    if (!body.alive || this.phase === 'over') {
      const rank = this.rankOf(slot);
      if (rank > 0) me.placement = rank;
    }
    return me;
  }

  private rankOf(slot: number): number {
    if (this.placements.length > 0) {
      const i = this.placements.indexOf(slot);
      return i === -1 ? 0 : i + 1;
    }
    const i = this.elimOrder.indexOf(slot);
    if (i === -1) return 0;
    return this.bodies.size - i;
  }

  private tick(dt: number) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'play';
        for (const body of this.bodies.values()) this.ctx.buzz(body.slot, 'go');
      }
      this.emitSnapshot();
      return;
    }
    if (this.phase === 'over') {
      this.emitSnapshot();
      return;
    }

    this.t += dt;

    // Shrinking floor.
    if (this.t > SHRINK_GRACE) {
      const p = Math.min(1, (this.t - SHRINK_GRACE) / SHRINK_DURATION);
      this.arenaR = ARENA_R0 - (ARENA_R0 - ARENA_R_MIN) * p;
    }

    this.updateEvent(dt);

    const frenzy = this.activeEventKind() === 'frenzy';
    const accel = frenzy ? ACCEL * 1.6 : ACCEL;
    let windX = 0;
    let windY = 0;
    if (this.event && this.event.kind === 'wind' && this.event.warn <= 0) {
      windX = (this.event.dx ?? 0) * WIND_FORCE;
      windY = (this.event.dy ?? 0) * WIND_FORCE;
    }

    // Integrate.
    for (const body of this.bodies.values()) {
      if (!body.alive) continue;
      body.vx += (body.joyX * accel + windX - DRAG * body.vx) * dt;
      body.vy += (body.joyY * accel + windY - DRAG * body.vy) * dt;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    }

    this.collidePlayers();
    this.collideObstacles();
    this.checkFalls();
    this.emitSnapshot();
  }

  private activeEventKind(): string | null {
    return this.event && this.event.warn <= 0 ? this.event.kind : null;
  }

  private updateEvent(dt: number) {
    if (this.event) {
      if (this.event.warn > 0) {
        this.event.warn = Math.max(0, this.event.warn - dt);
      } else {
        this.event.tLeft -= dt;
        if (this.event.tLeft <= 0) {
          this.event = null;
          this.nextEventAt = this.t + 10 + Math.random() * 8;
        }
      }
      return;
    }
    if (this.t >= this.nextEventAt) {
      const kinds = ['wind', 'bumpers', 'frenzy'] as const;
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const duration =
        kind === 'wind' ? WIND_DURATION : kind === 'bumpers' ? BUMPERS_DURATION : FRENZY_DURATION;
      const angle = Math.random() * Math.PI * 2;
      this.event = {
        kind,
        dx: kind === 'wind' ? Math.cos(angle) : undefined,
        dy: kind === 'wind' ? Math.sin(angle) : undefined,
        warn: EVENT_WARN,
        tLeft: duration,
        duration,
      };
    }
  }

  private collidePlayers() {
    const alive = [...this.bodies.values()].filter((b) => b.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = PLAYER_R * 2;
        if (dist >= minDist || dist === 0) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate.
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        // Impulse along the normal (equal masses).
        const relVn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relVn < 0) {
          const impulse = (-(1 + RESTITUTION_PLAYER) * relVn) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
          if (impulse > 120) {
            this.buzzBump(a);
            this.buzzBump(b);
          }
        }
      }
    }
  }

  private buzzBump(body: Body) {
    if (this.t - body.lastBumpBuzz < 0.5) return;
    body.lastBumpBuzz = this.t;
    this.ctx.buzz(body.slot, 'bumped');
  }

  private collideObstacles() {
    const bumperE =
      this.activeEventKind() === 'bumpers' ? RESTITUTION_BUMPER_FRENZY : RESTITUTION_BUMPER;
    for (const body of this.bodies.values()) {
      if (!body.alive) continue;
      for (const ob of this.obstacles) {
        const dx = body.x - ob.x;
        const dy = body.y - ob.y;
        const dist = Math.hypot(dx, dy);
        const minDist = ob.r + PLAYER_R;
        if (dist >= minDist || dist === 0) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        body.x = ob.x + nx * minDist;
        body.y = ob.y + ny * minDist;
        const vn = body.vx * nx + body.vy * ny;
        if (vn < 0) {
          body.vx -= (1 + bumperE) * vn * nx;
          body.vy -= (1 + bumperE) * vn * ny;
          // Pinball kick so even slow touches pop.
          const kick = this.activeEventKind() === 'bumpers' ? 220 : 60;
          body.vx += nx * kick;
          body.vy += ny * kick;
          this.buzzBump(body);
        }
      }
    }
  }

  private checkFalls() {
    for (const body of this.bodies.values()) {
      if (!body.alive) continue;
      if (Math.hypot(body.x, body.y) > this.arenaR + FALL_MARGIN) {
        body.alive = false;
        this.elimOrder.push(body.slot);
        this.ctx.buzz(body.slot, 'eliminated');
        this.ctx.emitMe(body.slot);
      }
    }
    const alive = [...this.bodies.values()].filter((b) => b.alive);
    if (this.bodies.size > 1 && alive.length <= 1) {
      this.phase = 'over';
      this.placements = [
        ...alive.map((b) => b.slot),
        ...[...this.elimOrder].reverse(),
      ];
      for (const body of this.bodies.values()) this.ctx.emitMe(body.slot);
    }
  }

  private emitSnapshot() {
    const players: LosPlayerTuple[] = [...this.bodies.values()].map((b) => [
      b.slot,
      Math.round(b.x),
      Math.round(b.y),
      b.alive ? 1 : 0,
    ]);
    const snapshot: LosSnapshot = {
      kind: 'los',
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      arenaR: Math.round(this.arenaR),
      players,
      obstacles: this.obstacles,
      event: this.event
        ? {
            kind: this.event.kind,
            dx: this.event.dx,
            dy: this.event.dy,
            warn: round1(this.event.warn),
            tLeft: round1(this.event.tLeft),
          }
        : null,
      aliveCount: [...this.bodies.values()].filter((b) => b.alive).length,
      placements: this.placements,
    };
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
