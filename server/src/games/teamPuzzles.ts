import type {
  GamePhase,
  InputPayload,
  MeState,
  PuzzlePieceSnap,
  PuzzleSnapshot,
} from '../../../shared/protocol';
import type { GameCtx, GameModule } from './types';

const TICK_MS = 1000 / 15;
const SPEED = 4.5; // cells per second while dragging
const COUNTDOWN = 3;
const NUDGE_TTL = 0.25; // seconds the "blocked" lean is reported
const ACTIVE_TTL = 0.4; // glow lingers briefly after the finger lifts

// Quadrant offsets within the assembled 2x2: 0 TL, 1 TR, 2 BL, 3 BR
const QUAD_DX = [0, 1, 0, 1];
const QUAD_DY = [0, 0, 1, 1];

interface Piece {
  id: number; // owner slot, or negative for phantom pieces
  slot: number | null;
  g: number;
  q: number;
  cx: number;
  cy: number;
  rot: number;
  locked: boolean;
  dirX: number;
  dirY: number;
  acc: number;
  activeUntil: number;
  nudgeX: number;
  nudgeY: number;
  nudgeUntil: number;
}

export class TeamPuzzles implements GameModule {
  readonly id = 'puzzle' as const;
  private readonly ctx: GameCtx;
  private cols = 0;
  private rows = 0;
  private readonly pieces: Piece[] = [];
  private readonly bySlot = new Map<number, Piece>();
  private grid: (Piece | null)[][] = [];
  private groupCount = 0;
  private finished: number[] = [];
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private t = 0;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
  }

  start() {
    this.layout();
    this.interval = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private layout() {
    const slots = this.ctx.slots().map((s) => s.slot);
    shuffle(slots);
    this.groupCount = Math.max(1, Math.ceil(slots.length / 4));
    const totalPieces = this.groupCount * 4;

    // Roughly 1/3 board occupancy, ~16:10 shape, always room for every 2x2.
    const cellsNeeded = Math.max(totalPieces * 3, 35);
    this.rows = Math.max(5, Math.ceil(Math.sqrt(cellsNeeded / 1.7)));
    this.cols = Math.max(7, Math.ceil(cellsNeeded / this.rows));
    this.grid = Array.from({ length: this.rows }, () =>
      Array<Piece | null>(this.cols).fill(null),
    );

    // Assign players to groups of 4; the last group may need phantom pieces.
    let phantomId = -1;
    for (let g = 0; g < this.groupCount; g++) {
      const members = slots.slice(g * 4, g * 4 + 4);
      const phantomQuads: number[] = [];
      for (let q = members.length; q < 4; q++) phantomQuads.push(q);

      if (phantomQuads.length > 0) {
        // Phantom pieces are pre-locked in a fixed, mutually consistent spot:
        // the team has to assemble around them.
        const origin = this.findPhantomOrigin();
        for (const q of phantomQuads) {
          const piece = this.makePiece(phantomId--, null, g, q);
          piece.locked = true;
          this.place(piece, origin.x + QUAD_DX[q], origin.y + QUAD_DY[q]);
        }
      }
      members.forEach((slot, q) => {
        const piece = this.makePiece(slot, slot, g, q);
        if (this.ctx.options.rotation) piece.rot = Math.floor(Math.random() * 4);
        const cell = this.randomFreeCell();
        this.place(piece, cell.x, cell.y);
        this.bySlot.set(slot, piece);
      });
    }
  }

  private makePiece(id: number, slot: number | null, g: number, q: number): Piece {
    const piece: Piece = {
      id,
      slot,
      g,
      q,
      cx: 0,
      cy: 0,
      rot: 0,
      locked: false,
      dirX: 0,
      dirY: 0,
      acc: 0,
      activeUntil: 0,
      nudgeX: 0,
      nudgeY: 0,
      nudgeUntil: 0,
    };
    this.pieces.push(piece);
    return piece;
  }

  private place(piece: Piece, cx: number, cy: number) {
    piece.cx = cx;
    piece.cy = cy;
    this.grid[cy][cx] = piece;
  }

  private randomFreeCell(): { x: number; y: number } {
    for (let tries = 0; tries < 2000; tries++) {
      const x = Math.floor(Math.random() * this.cols);
      const y = Math.floor(Math.random() * this.rows);
      if (!this.grid[y][x]) return { x, y };
    }
    // Fallback linear scan (should never be needed at 1/3 occupancy).
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (!this.grid[y][x]) return { x, y };
      }
    }
    throw new Error('board full');
  }

  private findPhantomOrigin(): { x: number; y: number } {
    for (let tries = 0; tries < 2000; tries++) {
      const x = 1 + Math.floor(Math.random() * (this.cols - 3));
      const y = 1 + Math.floor(Math.random() * (this.rows - 3));
      let free = true;
      for (let q = 0; q < 4; q++) {
        if (this.grid[y + QUAD_DY[q]][x + QUAD_DX[q]]) free = false;
      }
      if (free) return { x, y };
    }
    return { x: 1, y: 1 };
  }

  onJoin(_slot: number) {
    // Groups are formed at round start; a late joiner waits for the next round.
  }

  input(slot: number, payload: InputPayload) {
    const piece = this.bySlot.get(slot);
    if (!piece || this.phase === 'over') return;
    if (payload.t === 'dir') {
      piece.dirX = clampNum(payload.x, -1, 1);
      piece.dirY = clampNum(payload.y, -1, 1);
      if (Math.hypot(piece.dirX, piece.dirY) > 0.25) {
        piece.activeUntil = this.t + ACTIVE_TTL;
      }
    } else if (payload.t === 'touch') {
      piece.activeUntil = payload.down ? Number.MAX_SAFE_INTEGER : this.t + ACTIVE_TTL;
    } else if (payload.t === 'rot') {
      if (!this.ctx.options.rotation || piece.locked || this.phase !== 'play') return;
      piece.rot = (piece.rot + 1) % 4;
      this.checkSnap(piece.g);
    }
  }

  // Fake-player AI: rotate upright if needed, then walk (BFS around occupied
  // cells) to the spot implied by the group's leader piece — a human teammate
  // when there is one, so bots come and assemble around real players.
  botInput(slot: number): InputPayload | null {
    if (this.phase !== 'play') return null;
    const piece = this.bySlot.get(slot);
    if (!piece || piece.locked) return null;
    if (this.ctx.options.rotation && piece.rot !== 0 && Math.random() < 0.5) {
      return { t: 'rot' };
    }
    const [ox, oy] = this.computeBotOrigins().get(piece.g)!;
    const tx = ox + QUAD_DX[piece.q];
    const ty = oy + QUAD_DY[piece.q];
    if (tx === piece.cx && ty === piece.cy) return { t: 'dir', x: 0, y: 0 };
    const step = this.bfsStep(piece.cx, piece.cy, tx, ty);
    if (step) {
      const blocked = this.grid[piece.cy + step[1]][piece.cx + step[0]];
      // Waiting right next to an occupied target: usually hold, but sometimes
      // sidestep — a bot standing pat here can be part of a swap/rotation
      // cycle (e.g. two teammates on each other's target cells) that would
      // otherwise never resolve.
      if (!blocked || Math.random() > 0.35) {
        return { t: 'dir', x: step[0], y: step[1] };
      }
    }
    // Boxed in or breaking a wait cycle: shuffle toward any free neighbour.
    const options: [number, number][] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = piece.cx + dx;
      const ny = piece.cy + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      if (!this.grid[ny][nx]) options.push([dx, dy]);
    }
    const pick = options[Math.floor(Math.random() * options.length)];
    return pick ? { t: 'dir', x: pick[0], y: pick[1] } : { t: 'dir', x: 0, y: 0 };
  }

  // Assembly origins for every group, computed globally so all bots agree and
  // no two groups ever claim overlapping 2x2 areas (overlap deadlocks: parked
  // pieces never yield). Groups are resolved in ascending id order — later
  // groups shift to the nearest clear spot. Each group's preferred origin is
  // implied by its leader piece: a locked piece (phantom / finished) if any,
  // else the lowest-id human piece so bots assemble around real players, else
  // the lowest-id bot piece. Origins avoid the side columns so the 2x2 never
  // contains a board corner (a corner target cell can be walled in by parked
  // teammates).
  private computeBotOrigins(): Map<number, [number, number]> {
    const origins = new Map<number, [number, number]>();
    const claimed: [number, number][] = [];
    const overlaps = (ox: number, oy: number) =>
      claimed.some(([cx2, cy2]) => Math.abs(ox - cx2) < 2 && Math.abs(oy - cy2) < 2);
    const valid = (ox: number, oy: number, g: number) => {
      if (overlaps(ox, oy)) return false;
      for (let q = 0; q < 4; q++) {
        const cell = this.grid[oy + QUAD_DY[q]][ox + QUAD_DX[q]];
        if (cell && cell.locked && cell.g !== g) return false;
      }
      return true;
    };
    for (let g = 0; g < this.groupCount; g++) {
      const group = this.pieces.filter((p) => p.g === g);
      const leader =
        group.find((p) => p.locked) ??
        group
          .filter((p) => p.slot !== null && !this.ctx.isBot(p.slot))
          .sort((a, b) => a.id - b.id)[0] ??
        group.slice().sort((a, b) => a.id - b.id)[0];
      if (leader.locked) {
        // Fixed by a phantom or an already-finished assembly; never shifts.
        const ox = leader.cx - QUAD_DX[leader.q];
        const oy = leader.cy - QUAD_DY[leader.q];
        origins.set(g, [ox, oy]);
        claimed.push([ox, oy]);
        continue;
      }
      const ix = clampNum(leader.cx - QUAD_DX[leader.q], 1, this.cols - 3);
      const iy = clampNum(leader.cy - QUAD_DY[leader.q], 0, this.rows - 2);
      let best: [number, number] = [ix, iy];
      if (!valid(ix, iy, g)) {
        let bestDist = Infinity;
        for (let oy = 0; oy <= this.rows - 2; oy++) {
          for (let ox = 1; ox <= this.cols - 3; ox++) {
            if (!valid(ox, oy, g)) continue;
            const dist = Math.abs(ox - ix) + Math.abs(oy - iy);
            if (dist < bestDist) {
              best = [ox, oy];
              bestDist = dist;
            }
          }
        }
      }
      origins.set(g, best);
      claimed.push(best);
    }
    return origins;
  }

  // First step of a shortest path, treating occupied cells as walls (the
  // target counts as reachable even while occupied — the bot waits beside it).
  private bfsStep(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): [number, number] | null {
    const key = (x: number, y: number) => y * this.cols + x;
    const start = key(fromX, fromY);
    const target = key(toX, toY);
    const prev = new Map<number, number>();
    prev.set(start, -1);
    const queue = [start];
    while (queue.length > 0) {
      const cell = queue.shift()!;
      if (cell === target) {
        let cur = cell;
        for (;;) {
          const p = prev.get(cur)!;
          if (p === start) break;
          if (p === -1) return null;
          cur = p;
        }
        return [(cur % this.cols) - fromX, Math.floor(cur / this.cols) - fromY];
      }
      const cx = cell % this.cols;
      const cy = Math.floor(cell / this.cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const nk = key(nx, ny);
        if (prev.has(nk)) continue;
        if (this.grid[ny][nx] && nk !== target) continue;
        prev.set(nk, cell);
        queue.push(nk);
      }
    }
    return null;
  }

  personal(slot: number): Partial<MeState> {
    const piece = this.bySlot.get(slot);
    if (!piece) return { waiting: true };
    const me: Partial<MeState> = {
      group: piece.g,
      quadrant: piece.q,
      rotationEnabled: this.ctx.options.rotation,
    };
    const rank = this.finished.indexOf(piece.g);
    if (rank !== -1) me.teamRank = rank + 1;
    return me;
  }

  private tick(dt: number) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'play';
        for (const piece of this.pieces) {
          if (piece.slot !== null) this.ctx.buzz(piece.slot, 'go');
        }
      }
      this.emitSnapshot();
      return;
    }

    this.t += dt;
    if (this.phase === 'play') {
      for (const piece of this.pieces) {
        if (piece.locked || piece.slot === null) continue;
        const mag = Math.hypot(piece.dirX, piece.dirY);
        if (mag < 0.25) {
          piece.acc = 0;
          continue;
        }
        piece.acc += SPEED * dt;
        while (piece.acc >= 1) {
          piece.acc -= 1;
          if (!this.tryStep(piece)) {
            piece.acc = 0;
            break;
          }
        }
      }
    }
    this.emitSnapshot();
  }

  // Step along the dominant axis; slide along the other axis when blocked.
  private tryStep(piece: Piece): boolean {
    const ax = Math.abs(piece.dirX);
    const ay = Math.abs(piece.dirY);
    const primary: [number, number] =
      ax >= ay ? [Math.sign(piece.dirX), 0] : [0, Math.sign(piece.dirY)];
    const secondary: [number, number] =
      ax >= ay ? [0, Math.sign(piece.dirY)] : [Math.sign(piece.dirX), 0];
    const attempts: [number, number][] = [primary];
    if ((ax >= ay ? ay : ax) > 0.35) attempts.push(secondary);

    for (const [dx, dy] of attempts) {
      if (dx === 0 && dy === 0) continue;
      const nx = piece.cx + dx;
      const ny = piece.cy + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      if (this.grid[ny][nx]) continue;
      this.grid[piece.cy][piece.cx] = null;
      this.place(piece, nx, ny);
      this.checkSnap(piece.g);
      return true;
    }
    piece.nudgeX = primary[0];
    piece.nudgeY = primary[1];
    piece.nudgeUntil = this.t + NUDGE_TTL;
    return false;
  }

  private checkSnap(g: number) {
    const group = this.pieces.filter((p) => p.g === g);
    if (group.length !== 4 || group.some((p) => p.g !== g)) return;
    if (this.finished.includes(g)) return;
    let originX: number | null = null;
    let originY: number | null = null;
    for (const piece of group) {
      if (this.ctx.options.rotation && piece.rot !== 0) return;
      const ox = piece.cx - QUAD_DX[piece.q];
      const oy = piece.cy - QUAD_DY[piece.q];
      if (originX === null) {
        originX = ox;
        originY = oy;
      } else if (ox !== originX || oy !== originY) {
        return;
      }
    }
    // Assembled!
    this.finished.push(g);
    for (const piece of group) {
      piece.locked = true;
      piece.dirX = 0;
      piece.dirY = 0;
      if (piece.slot !== null) {
        this.ctx.buzz(piece.slot, 'locked');
        this.ctx.emitMe(piece.slot);
      }
    }
    if (this.finished.length === this.groupCount) {
      this.phase = 'over';
    }
  }

  private emitSnapshot() {
    const pieces: PuzzlePieceSnap[] = this.pieces.map((p) => ({
      id: p.id,
      g: p.g,
      q: p.q,
      cx: p.cx,
      cy: p.cy,
      rot: p.rot,
      locked: p.locked,
      active: p.activeUntil > this.t,
      nx: p.nudgeUntil > this.t ? p.nudgeX : 0,
      ny: p.nudgeUntil > this.t ? p.nudgeY : 0,
    }));
    const snapshot: PuzzleSnapshot = {
      kind: 'puzzle',
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      cols: this.cols,
      rows: this.rows,
      pieces,
      groupCount: this.groupCount,
      finished: this.finished,
    };
    this.ctx.emitStage(snapshot);
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function clampNum(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(max, Math.max(min, n));
}
