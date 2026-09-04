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
const STALE_AFTER = 4; // seconds without moving before a piece counts as idle
const PHANTOM_CHECK_EVERY = 1; // seconds between blocked-phantom-area checks

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
  lastMovedAt: number; // game seconds of the last successful step/rotation
}

export class TeamPuzzles implements GameModule {
  readonly id = 'puzzle' as const;
  private readonly ctx: GameCtx;
  private readonly gw: number;
  private readonly gh: number;
  private cols = 0;
  private rows = 0;
  private readonly pieces: Piece[] = [];
  private readonly bySlot = new Map<number, Piece>();
  private grid: (Piece | null)[][] = [];
  private groupCount = 0;
  private groupImages: (string | null)[] = [];
  private finished: number[] = [];
  private phase: GamePhase = 'countdown';
  private countdown = COUNTDOWN;
  private t = 0;
  private nextPhantomCheck = PHANTOM_CHECK_EVERY;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: GameCtx) {
    this.ctx = ctx;
    this.gw = ctx.options.puzzleW;
    this.gh = ctx.options.puzzleH;
  }

  // Cell offset of piece index q within the gw x gh puzzle (reading order).
  private qx(q: number): number {
    return q % this.gw;
  }
  private qy(q: number): number {
    return Math.floor(q / this.gw);
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
    const K = this.gw * this.gh;
    const slots = this.ctx.slots().map((s) => s.slot);
    shuffle(slots);
    this.groupCount = Math.max(1, Math.ceil(slots.length / K));
    const totalPieces = this.groupCount * K;

    // Generous board: enough cells that every assembly area fits with a
    // one-cell buffer AND open field remains for routing around them.
    const cellsNeeded = Math.max(
      totalPieces * 4,
      (this.gw + 2) * (this.gh + 2) * this.groupCount,
      35,
    );
    this.rows = Math.max(this.gh + 3, 5, Math.ceil(Math.sqrt(cellsNeeded / 1.7)));
    this.cols = Math.max(this.gw + 4, 7, Math.ceil(cellsNeeded / this.rows));
    // Guarantee the buffered assembly-area lattice can hold every group —
    // otherwise phantom placement (and bot claims) can run out of room.
    while (
      Math.floor((this.cols - 2) / (this.gw + 1)) *
        Math.floor(this.rows / (this.gh + 1)) <
      this.groupCount
    ) {
      if (this.cols <= this.rows * 1.7) this.cols++;
      else this.rows++;
    }
    this.grid = Array.from({ length: this.rows }, () =>
      Array<Piece | null>(this.cols).fill(null),
    );

    // One uploaded picture per team (upload order); leftover teams keep the
    // procedural artwork seeded by their group id.
    const imageIds = this.ctx.imageIds();
    this.groupImages = Array.from({ length: this.groupCount }, (_, g) => imageIds[g] ?? null);

    // Deal players round-robin so team sizes differ by at most one; the
    // missing positions in short teams become pre-locked phantom pieces.
    const members: number[][] = Array.from({ length: this.groupCount }, () => []);
    slots.forEach((slot, i) => members[i % this.groupCount].push(slot));

    // Phase 1: place every phantom area on the still-empty board (the
    // buffered lattice needs clear slots). Phantoms are pre-locked in a
    // fixed, mutually consistent spot the team assembles around, and the
    // placement must never seal a free area cell away from the outside
    // (phantoms are immovable walls).
    let phantomId = -1;
    const phantomOrigins: [number, number][] = [];
    const groupPositions: number[][] = [];
    for (let g = 0; g < this.groupCount; g++) {
      const positions = Array.from({ length: K }, (_, q) => q);
      shuffle(positions);
      groupPositions.push(positions);
      const phantomQs = positions.slice(members[g].length);
      if (phantomQs.length === 0) continue;
      let origin: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 40 && !origin; attempt++) {
        const cand = this.findPhantomOrigin(phantomOrigins);
        if (!cand) break;
        if (this.phantomPlacementOk(cand.x, cand.y, phantomQs)) origin = cand;
      }
      origin ??=
        this.findPhantomOrigin(phantomOrigins) ?? this.findFreeOriginLoose(phantomQs);
      if (origin) {
        phantomOrigins.push([origin.x, origin.y]);
        for (const q of phantomQs) {
          const piece = this.makePiece(phantomId--, null, g, q);
          piece.locked = true;
          this.place(piece, origin.x + this.qx(q), origin.y + this.qy(q));
        }
      } else {
        // Should be impossible on a properly sized board: scatter unlocked
        // stand-in pieces rather than corrupting the grid.
        for (const q of phantomQs) {
          const piece = this.makePiece(phantomId--, null, g, q);
          const cell = this.randomFreeCell();
          this.place(piece, cell.x, cell.y);
        }
      }
    }

    // Phase 2: scatter the player pieces over the remaining free cells.
    for (let g = 0; g < this.groupCount; g++) {
      members[g].forEach((slot, i) => {
        const piece = this.makePiece(slot, slot, g, groupPositions[g][i]);
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
      lastMovedAt: 0,
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
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (!this.grid[y][x]) return { x, y };
      }
    }
    throw new Error('board full');
  }

  // A free gw x gh region for phantom pieces, drawn from a stride-(g+1)
  // lattice so every area keeps a one-cell buffer from its neighbours (two
  // flush areas can jointly wall in the cells along their shared border) and
  // stays off the x edges (a corner cell inside an area can be walled in by
  // parked teammates). Board sizing guarantees enough lattice slots.
  private findPhantomOrigin(
    taken: [number, number][],
  ): { x: number; y: number } | null {
    const slots: [number, number][] = [];
    for (let y = 0; y + this.gh <= this.rows; y += this.gh + 1) {
      for (let x = 1; x + this.gw <= this.cols - 1; x += this.gw + 1) {
        slots.push([x, y]);
      }
    }
    shuffle(slots);
    for (const [x, y] of slots) {
      let ok = true;
      for (const [tx, ty] of taken) {
        if (Math.abs(x - tx) < this.gw + 1 && Math.abs(y - ty) < this.gh + 1) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let q = 0; q < this.gw * this.gh && ok; q++) {
        if (this.grid[y + this.qy(q)][x + this.qx(q)]) ok = false;
      }
      if (ok) return { x, y };
    }
    return null;
  }

  // Last-resort origin search: any region whose cells are simply free (no
  // buffer guarantees). Never overwrites occupied cells.
  private findFreeOriginLoose(phantomQs: number[]): { x: number; y: number } | null {
    for (let y = 0; y + this.gh <= this.rows; y++) {
      for (let x = 1; x + this.gw <= this.cols - 1; x++) {
        let ok = true;
        for (let q = 0; q < this.gw * this.gh && ok; q++) {
          if (this.grid[y + this.qy(q)][x + this.qx(q)]) ok = false;
        }
        if (ok && this.phantomPlacementOk(x, y, phantomQs)) return { x, y };
      }
    }
    return null;
  }

  // BFS depth of every area cell to the outside of the gw x gh area at
  // (ox,oy), with `isWall` cells impassable. A cell missing from the result
  // is sealed. Depth 1 = touches a passable outside cell.
  private computeAreaDepths(
    ox: number,
    oy: number,
    isWall: (x: number, y: number) => boolean,
  ): Map<number, number> {
    const key = (x: number, y: number) => y * this.cols + x;
    const inArea = (x: number, y: number) =>
      x >= ox && x < ox + this.gw && y >= oy && y < oy + this.gh;
    const depths = new Map<number, number>();
    const queue: [number, number][] = [];
    for (let q = 0; q < this.gw * this.gh; q++) {
      const x = ox + this.qx(q);
      const y = oy + this.qy(q);
      if (isWall(x, y)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        if (inArea(nx, ny) || isWall(nx, ny)) continue;
        depths.set(key(x, y), 1);
        queue.push([x, y]);
        break;
      }
    }
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      const d = depths.get(key(x, y))!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inArea(nx, ny) || isWall(nx, ny)) continue;
        if (depths.has(key(nx, ny))) continue;
        depths.set(key(nx, ny), d + 1);
        queue.push([nx, ny]);
      }
    }
    return depths;
  }

  // Would placing this group's phantoms at (ox,oy) leave every free area cell
  // reachable from outside?
  private phantomPlacementOk(ox: number, oy: number, phantomQs: number[]): boolean {
    const phantomCells = new Set(
      phantomQs.map((q) => (oy + this.qy(q)) * this.cols + (ox + this.qx(q))),
    );
    const isWall = (x: number, y: number) =>
      phantomCells.has(y * this.cols + x) || (this.grid[y][x]?.locked ?? false);
    const depths = this.computeAreaDepths(ox, oy, isWall);
    for (let q = 0; q < this.gw * this.gh; q++) {
      const x = ox + this.qx(q);
      const y = oy + this.qy(q);
      if (isWall(x, y)) continue;
      if (!depths.has(y * this.cols + x)) return false;
    }
    return true;
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
      piece.lastMovedAt = this.t;
      this.checkSnap(piece.g);
    }
  }

  // Fake-player AI: rotate upright if needed, then walk (BFS around occupied
  // cells) to the spot implied by the group's leader piece — a human teammate
  // when there is one, so bots come and assemble around real players.
  botInput(slot: number): InputPayload | null {
    const out = this.botInputInner(slot);
    if (process.env.PUZZLE_DEBUG && this.t - this.lastDebugLog > 2) {
      const piece = this.bySlot.get(slot);
      if (piece && !piece.locked) {
        const origin = this.computeBotOrigins().get(piece.g);
        let cells = '';
        if (origin) {
          const depths = this.computeAreaDepths(
            origin[0],
            origin[1],
            (x, y) => this.grid[y][x]?.locked ?? false,
          );
          for (let q = 0; q < this.gw * this.gh; q++) {
            const x = origin[0] + this.qx(q);
            const y = origin[1] + this.qy(q);
            const cell = this.grid[y]?.[x];
            cells += ` q${q}:(${x},${y})d${depths.get(y * this.cols + x) ?? '∞'}${cell ? `=${cell.g}/${cell.q}${cell.locked ? '*' : ''}` : ''}`;
          }
        }
        console.log(
          `[bot] t=${this.t.toFixed(1)} slot=${slot} g=${piece.g} q=${piece.q} at=(${piece.cx},${piece.cy}) origin=${origin} runner=${origin ? this.isRunner(piece, origin[0], origin[1]) : '?'} out=${JSON.stringify(out)}${cells}`,
        );
      }
      if (slot === Math.max(...this.bySlot.keys())) this.lastDebugLog = this.t;
    }
    return out;
  }

  private lastDebugLog = -10;

  private botInputInner(slot: number): InputPayload | null {
    if (this.phase !== 'play') return null;
    const piece = this.bySlot.get(slot);
    if (!piece || piece.locked) return null;
    // Occasionally skip a beat (keeping the previous input): bots that all
    // re-decide on the same tick can mirror each other's avoidance forever —
    // the classic two-people-in-a-corridor livelock.
    if (Math.random() < 0.15) return null;
    if (this.ctx.options.rotation && piece.rot !== 0 && Math.random() < 0.5) {
      return { t: 'rot' };
    }
    const origins = this.computeBotOrigins();
    const [ox, oy] = origins.get(piece.g)!;
    const tx = ox + this.qx(piece.q);
    const ty = oy + this.qy(piece.q);
    const atTarget = tx === piece.cx && ty === piece.cy;
    // Fill deep-before-shallow: park (or stay parked) only once every deeper
    // free cell of the area is correctly filled — otherwise a parked teammate
    // can seal an edge-flush or interior cell forever (parked bots never move
    // again). This also covers a bot that wandered onto its target early.
    if (atTarget) {
      if (this.canParkNow(piece, ox, oy, tx, ty)) return { t: 'dir', x: 0, y: 0 };
      return this.waitClearOfClaims(piece, origins);
    }
    // One runner at a time per group: only the bot whose spot is the deepest
    // unfilled cell approaches; the rest hold well back (≥2 cells from the
    // area), keeping the runner's corridors clear. Waiters hovering right at
    // the rim otherwise plug the single entrance to an edge-flush cell.
    if (!this.isRunner(piece, ox, oy)) {
      return this.waitClearOfClaims(piece, origins);
    }
    // Never path through another group's claimed area: a bot caught inside
    // one when pieces park around it is entombed for good. The one-cell
    // buffer between claims guarantees corridors around them.
    const foreignClaim = (x: number, y: number) => {
      for (const [g2, [cox, coy]] of origins) {
        if (g2 === piece.g) continue;
        if (x >= cox && x < cox + this.gw && y >= coy && y < coy + this.gh) return true;
      }
      return false;
    };
    const step = this.bfsStep(piece.cx, piece.cy, tx, ty, foreignClaim);
    if (step) {
      const landsOnTarget = piece.cx + step[0] === tx && piece.cy + step[1] === ty;
      if (landsOnTarget && !this.canParkNow(piece, ox, oy, tx, ty)) {
        return this.waitClearOfClaims(piece, origins);
      }
      const blocked = this.grid[piece.cy + step[1]][piece.cx + step[0]];
      // Waiting right next to an occupied target: usually hold, but sometimes
      // sidestep — a bot standing pat here can be part of a swap/rotation
      // cycle (e.g. two teammates on each other's target cells) that would
      // otherwise never resolve.
      if (!blocked || Math.random() > 0.35) {
        return { t: 'dir', x: step[0], y: step[1] };
      }
      // Sidestep to a free neighbour outside foreign claims.
      const options: [number, number][] = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = piece.cx + dx;
        const ny = piece.cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        if (this.grid[ny][nx] || foreignClaim(nx, ny)) continue;
        options.push([dx, dy]);
      }
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? { t: 'dir', x: pick[0], y: pick[1] } : { t: 'dir', x: 0, y: 0 };
    }
    // No route right now (corridor plugged, or we're stranded inside someone
    // else's claim): move out of all claims and drift until a path opens.
    return this.waitClearOfClaims(piece, origins);
  }

  // Is this piece the one whose turn it is to enter the area? The deepest
  // unfilled cell goes first (ties broken by q), so nobody ever parks in a
  // way that seals a deeper teammate out.
  private isRunner(piece: Piece, ox: number, oy: number): boolean {
    const depths = this.computeAreaDepths(
      ox,
      oy,
      (x, y) => this.grid[y][x]?.locked ?? false,
    );
    let runnerQ = -1;
    let runnerDepth = -1;
    for (let q = 0; q < this.gw * this.gh; q++) {
      const x = ox + this.qx(q);
      const y = oy + this.qy(q);
      const cell = this.grid[y][x];
      const satisfied =
        cell &&
        cell.g === piece.g &&
        ox + this.qx(cell.q) === x &&
        oy + this.qy(cell.q) === y;
      if (satisfied) continue;
      const d = depths.get(y * this.cols + x) ?? Number.MAX_SAFE_INTEGER;
      if (d > runnerDepth || (d === runnerDepth && q > runnerQ)) {
        runnerDepth = d;
        runnerQ = q;
      }
    }
    return runnerQ === piece.q;
  }

  private canParkNow(piece: Piece, ox: number, oy: number, tx: number, ty: number): boolean {
    const depths = this.computeAreaDepths(
      ox,
      oy,
      (x, y) => this.grid[y][x]?.locked ?? false,
    );
    const myDepth = depths.get(ty * this.cols + tx);
    if (myDepth === undefined) return false; // sealed — claims/relocation will adjust
    for (let q = 0; q < this.gw * this.gh; q++) {
      const x = ox + this.qx(q);
      const y = oy + this.qy(q);
      const cell = this.grid[y][x];
      if (cell?.locked) continue;
      const d = depths.get(y * this.cols + x);
      if (d !== undefined && d <= myDepth) continue;
      // Deeper (or sealed) cell: must already hold the teammate whose spot it is.
      const satisfied =
        cell &&
        cell.g === piece.g &&
        ox + this.qx(cell.q) === x &&
        oy + this.qy(cell.q) === y;
      if (!satisfied) return false;
    }
    // Never entomb a movable neighbour: parking must leave every adjacent
    // piece that still needs to move at least one free cell to escape to.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      const other = this.grid[ny][nx];
      if (!other || other.locked || other === piece) continue;
      const otherOrigin = this.originsMemo?.origins.get(other.g);
      const otherParked =
        otherOrigin &&
        otherOrigin[0] + this.qx(other.q) === nx &&
        otherOrigin[1] + this.qy(other.q) === ny;
      if (otherParked) continue; // settled where it belongs, needs no exit
      let exits = 0;
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ax = nx + ex;
        const ay = ny + ey;
        if (ax < 0 || ay < 0 || ax >= this.cols || ay >= this.rows) continue;
        if (ax === tx && ay === ty) continue; // I'm about to fill this one
        if (ax === piece.cx && ay === piece.cy) exits++; // I'm vacating mine
        else if (!this.grid[ay][ax]) exits++;
      }
      if (exits === 0) return false;
    }
    return true;
  }

  // Waiting for a deeper teammate: get (and stay) out of EVERY group's
  // claimed assembly area — squatting inside one blocks that team — and
  // jiggle occasionally so a stationary waiter can't squat on the deep
  // teammate's only way in.
  private waitClearOfClaims(
    piece: Piece,
    origins: Map<number, [number, number]>,
  ): InputPayload {
    // Keep out of every claimed area AND its one-cell rim: the rim cells are
    // the corridors runners arrive through, and a waiter camped there plugs
    // the only entrance to an edge-flush cell.
    const inAnyClaim = (x: number, y: number) => {
      for (const [cox, coy] of origins.values()) {
        if (
          x >= cox - 1 &&
          x < cox + this.gw + 1 &&
          y >= coy - 1 &&
          y < coy + this.gh + 1
        ) {
          return true;
        }
      }
      return false;
    };
    if (inAnyClaim(piece.cx, piece.cy)) {
      // Walk to the nearest free cell outside all claims.
      const key = (x: number, y: number) => y * this.cols + x;
      const start = key(piece.cx, piece.cy);
      const prev = new Map<number, number>();
      prev.set(start, -1);
      const queue = [start];
      const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      shuffle(dirs);
      while (queue.length > 0) {
        const cell = queue.shift()!;
        const cx = cell % this.cols;
        const cy = Math.floor(cell / this.cols);
        if (!inAnyClaim(cx, cy)) {
          let cur = cell;
          for (;;) {
            const p = prev.get(cur)!;
            if (p === start) break;
            if (p === -1) return { t: 'dir', x: 0, y: 0 };
            cur = p;
          }
          return {
            t: 'dir',
            x: (cur % this.cols) - piece.cx,
            y: Math.floor(cur / this.cols) - piece.cy,
          };
        }
        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          const nk = key(nx, ny);
          if (prev.has(nk)) continue;
          if (this.grid[ny][nx]) continue;
          prev.set(nk, cell);
          queue.push(nk);
        }
      }
      return { t: 'dir', x: 0, y: 0 }; // boxed in — retry next tick
    }
    if (Math.random() < 0.3) {
      const jiggle: [number, number][] = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = piece.cx + dx;
        const ny = piece.cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        if (this.grid[ny][nx] || inAnyClaim(nx, ny)) continue;
        jiggle.push([dx, dy]);
      }
      const pick = jiggle[Math.floor(Math.random() * jiggle.length)];
      if (pick) return { t: 'dir', x: pick[0], y: pick[1] };
    }
    return { t: 'dir', x: 0, y: 0 };
  }

  // Assembly origins for every group, computed globally so all bots agree and
  // no two groups ever claim overlapping areas (overlap deadlocks: parked
  // pieces never yield). Groups are resolved in ascending id order — later
  // groups shift to the nearest clear spot. Each group's preferred origin is
  // implied by its leader piece: a locked piece (phantom / finished) if any,
  // else the lowest-id human piece so bots assemble around real players, else
  // the lowest-id bot piece. A claim is invalid over locked foreign pieces
  // AND over stale foreign pieces (idle humans) — a piece that hasn't moved
  // in a while will not move out of the way either, and claiming its cell
  // used to freeze the bot that needed it. Origins avoid the side columns so
  // an area never contains a board corner.
  private originsMemo: { t: number; origins: Map<number, [number, number]> } | null = null;

  private computeBotOrigins(): Map<number, [number, number]> {
    // All bots in one ticker sweep share the same game time — compute once.
    if (this.originsMemo && this.originsMemo.t === this.t) return this.originsMemo.origins;
    const origins = new Map<number, [number, number]>();
    const claimed: [number, number][] = [];
    // One-cell buffer between claims: pieces parked along the shared border
    // of two flush areas can permanently seal the cells between them.
    const overlaps = (ox: number, oy: number) =>
      claimed.some(
        ([cx2, cy2]) =>
          Math.abs(ox - cx2) < this.gw + 1 && Math.abs(oy - cy2) < this.gh + 1,
      );
    const areaOk = (ox: number, oy: number, g: number, strict: boolean) => {
      if (overlaps(ox, oy)) return false;
      for (let q = 0; q < this.gw * this.gh; q++) {
        const cell = this.grid[oy + this.qy(q)][ox + this.qx(q)];
        if (!cell || cell.g === g) continue;
        if (cell.locked) return false;
        if (strict && this.t - cell.lastMovedAt > STALE_AFTER) return false;
      }
      // Every cell must also be reachable from outside — locked pieces just
      // beyond the area's rim can seal a cell as surely as ones inside it.
      const depths = this.computeAreaDepths(
        ox,
        oy,
        (x, y) => this.grid[y][x]?.locked ?? false,
      );
      for (let q = 0; q < this.gw * this.gh; q++) {
        const x = ox + this.qx(q);
        const y = oy + this.qy(q);
        if (this.grid[y][x]?.locked) continue;
        if (!depths.has(y * this.cols + x)) return false;
      }
      return true;
    };
    const maxX = this.cols - this.gw - 1;
    const maxY = this.rows - this.gh;
    // Pass 1: groups with a locked anchor (phantoms, finished assemblies)
    // have immovable areas — register them all first so every movable claim
    // keeps its buffer from them regardless of group order.
    const leaders = new Map<number, Piece>();
    for (let g = 0; g < this.groupCount; g++) {
      const group = this.pieces.filter((p) => p.g === g);
      const leader =
        group.find((p) => p.locked) ??
        group
          .filter((p) => p.slot !== null && !this.ctx.isBot(p.slot))
          .sort((a, b) => a.id - b.id)[0] ??
        group.slice().sort((a, b) => a.id - b.id)[0];
      leaders.set(g, leader);
      if (leader.locked) {
        const ox = leader.cx - this.qx(leader.q);
        const oy = leader.cy - this.qy(leader.q);
        origins.set(g, [ox, oy]);
        claimed.push([ox, oy]);
      }
    }
    // Pass 2: movable claims, ascending group id.
    for (let g = 0; g < this.groupCount; g++) {
      if (origins.has(g)) continue;
      const leader = leaders.get(g)!;
      const ix = clampNum(leader.cx - this.qx(leader.q), 1, Math.max(1, maxX));
      const iy = clampNum(leader.cy - this.qy(leader.q), 0, Math.max(0, maxY));
      let best: [number, number] | null = null;
      for (const strict of [true, false]) {
        if (areaOk(ix, iy, g, strict)) {
          best = [ix, iy];
          break;
        }
        let bestDist = Infinity;
        for (let oy = 0; oy <= maxY; oy++) {
          for (let ox = 1; ox <= maxX; ox++) {
            if (!areaOk(ox, oy, g, strict)) continue;
            const dist = Math.abs(ox - ix) + Math.abs(oy - iy);
            if (dist < bestDist) {
              best = [ox, oy];
              bestDist = dist;
            }
          }
        }
        if (best) break;
      }
      const origin = best ?? [ix, iy];
      origins.set(g, origin);
      claimed.push(origin);
    }
    this.originsMemo = { t: this.t, origins };
    return origins;
  }

  // First step of a shortest path, treating occupied cells (and any `avoid`
  // cells) as walls; the target counts as reachable even while occupied — the
  // bot waits beside it.
  private bfsStep(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    avoid?: (x: number, y: number) => boolean,
  ): [number, number] | null {
    const key = (x: number, y: number) => y * this.cols + x;
    const start = key(fromX, fromY);
    const target = key(toX, toY);
    const prev = new Map<number, number>();
    prev.set(start, -1);
    const queue = [start];
    // Random neighbour order: equal-length paths then vary from call to call,
    // desynchronising bots that would otherwise mirror each other forever.
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    shuffle(dirs);
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
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const nk = key(nx, ny);
        if (prev.has(nk)) continue;
        if (nk !== target && (this.grid[ny][nx] || avoid?.(nx, ny))) continue;
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
      gw: this.gw,
      gh: this.gh,
      imageId: this.groupImages[piece.g] ?? null,
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
      if (this.t >= this.nextPhantomCheck) {
        this.nextPhantomCheck = this.t + PHANTOM_CHECK_EVERY;
        this.relocateBlockedPhantoms();
      }
    }
    this.emitSnapshot();
  }

  // If another team locked its puzzle on top of a phantom group's assembly
  // area, that group could never finish — the phantoms are immovable and so
  // are the foreign locked pieces. Move the phantoms to a fresh clear region
  // instead; the stage's tween shows the anchor sliding to its new home.
  private relocateBlockedPhantoms() {
    const byGroup = new Map<number, Piece[]>();
    for (const piece of this.pieces) {
      if (piece.id < 0 && !this.finished.includes(piece.g)) {
        const list = byGroup.get(piece.g) ?? [];
        list.push(piece);
        byGroup.set(piece.g, list);
      }
    }
    for (const [g, phantoms] of byGroup) {
      const ox = phantoms[0].cx - this.qx(phantoms[0].q);
      const oy = phantoms[0].cy - this.qy(phantoms[0].q);
      let blocked = false;
      for (let q = 0; q < this.gw * this.gh; q++) {
        const cell = this.grid[oy + this.qy(q)]?.[ox + this.qx(q)];
        if (cell && cell.locked && cell.g !== g) {
          blocked = true;
          break;
        }
      }
      if (!blocked) continue;
      // Lift the phantoms off the grid, find a clear region, drop them there.
      // The new region must respect the buffer around every OTHER phantom
      // group's area — overlapping areas make both puzzles unsolvable.
      const taken: [number, number][] = [];
      for (const [g2, others] of byGroup) {
        if (g2 === g) continue;
        taken.push([
          others[0].cx - this.qx(others[0].q),
          others[0].cy - this.qy(others[0].q),
        ]);
      }
      for (const p of phantoms) this.grid[p.cy][p.cx] = null;
      const phantomQs = phantoms.map((p) => p.q);
      let origin: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 40 && !origin; attempt++) {
        const cand = this.findPhantomOrigin(taken);
        if (!cand) break;
        if (this.phantomPlacementOk(cand.x, cand.y, phantomQs)) origin = cand;
      }
      if (!origin) {
        // No clear region right now — put them back and retry next check.
        for (const p of phantoms) this.grid[p.cy][p.cx] = p;
        continue;
      }
      for (const p of phantoms) {
        this.place(p, origin.x + this.qx(p.q), origin.y + this.qy(p.q));
        p.lastMovedAt = this.t;
      }
      this.checkSnap(g);
    }
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
      piece.lastMovedAt = this.t;
      this.checkSnap(piece.g);
      return true;
    }
    piece.nudgeX = primary[0];
    piece.nudgeY = primary[1];
    piece.nudgeUntil = this.t + NUDGE_TTL;
    return false;
  }

  private checkSnap(g: number) {
    const K = this.gw * this.gh;
    const group = this.pieces.filter((p) => p.g === g);
    if (group.length !== K) return;
    if (this.finished.includes(g)) return;
    let originX: number | null = null;
    let originY: number | null = null;
    for (const piece of group) {
      if (this.ctx.options.rotation && piece.rot !== 0) return;
      const ox = piece.cx - this.qx(piece.q);
      const oy = piece.cy - this.qy(piece.q);
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
      gw: this.gw,
      gh: this.gh,
      pieces,
      groupCount: this.groupCount,
      groupImages: this.groupImages,
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
