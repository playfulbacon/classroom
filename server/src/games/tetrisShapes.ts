// Human Tetris shape generation: the safe zone the crowd has to fill before
// the wall drops. Every shape is a 4-connected blob of unit cells carved out
// of a random rectangle — bites out of the edges for an irregular outline,
// and true interior HOLES (empty cells sealed on all four sides) that the
// crowd has to flow around. The blob always holds at least `minCells` so
// the round is physically possible, and it lands somewhere random on the
// field with a one-cell margin so no shape ever hugs the edge.

import type { TetrisShape } from '../../../shared/protocol';

type Rng = () => number;

export function generateShape(
  fieldW: number,
  fieldD: number,
  minCells: number,
  rng: Rng = Math.random,
): TetrisShape {
  const maxW = Math.max(1, fieldW - 2);
  const maxH = Math.max(1, fieldD - 2);
  const need = Math.max(1, Math.min(minCells, maxW * maxH));

  // Bounding box: roomier than the requirement so there's material to
  // carve; a random aspect so shapes lie tall, wide or square.
  const total = Math.ceil(need * (1.45 + rng() * 0.55));
  let w = Math.round(Math.sqrt(total) * (0.75 + rng() * 0.9));
  w = Math.max(2, Math.min(maxW, w));
  let h = Math.ceil(total / w);
  h = Math.max(2, Math.min(maxH, h));
  if (w * h < need) w = Math.min(maxW, Math.ceil(need / h));
  if (w * h < need) h = Math.min(maxH, Math.ceil(need / w));

  const grid: boolean[] = new Array(w * h).fill(true);
  let count = w * h;
  const holes = new Set<number>();
  const target = Math.min(count, need + Math.floor(rng() * 2));
  const idx = (c: number, r: number) => r * w + c;
  const filled = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h && grid[idx(c, r)];

  // Interior holes first (only possible with a 3x3+ box): cells whose four
  // neighbours are all solid, occasionally grown to a second cell. Most
  // shapes get one to three; one in five is solid, for variety.
  if (w >= 3 && h >= 3) {
    const wanted = rng() < 0.2 ? 0 : 1 + Math.floor(rng() * 3);
    for (let hole = 0; hole < wanted && count > target; hole++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const c = 1 + Math.floor(rng() * (w - 2));
        const r = 1 + Math.floor(rng() * (h - 2));
        if (!isSealedInterior(c, r)) continue;
        if (!removable(c, r)) continue;
        grid[idx(c, r)] = false;
        holes.add(idx(c, r));
        count--;
        if (count > target && rng() < 0.4) {
          const dirs = shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]] as const, rng);
          for (const [dc, dr] of dirs) {
            const c2 = c + dc;
            const r2 = r + dr;
            if (c2 < 1 || r2 < 1 || c2 > w - 2 || r2 > h - 2) continue;
            if (!filled(c2, r2) || !removable(c2, r2)) continue;
            // Keep the grown hole sealed: every neighbour of the second
            // cell other than the first must stay solid.
            let sealed = true;
            for (const [ec, er] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nc = c2 + ec;
              const nr = r2 + er;
              if (nc === c && nr === r) continue;
              if (!filled(nc, nr)) sealed = false;
            }
            if (!sealed) continue;
            grid[idx(c2, r2)] = false;
            holes.add(idx(c2, r2));
            count--;
            break;
          }
        }
        break;
      }
    }
  }

  // Then bites out of the outline, never touching a hole's rim (so holes
  // stay holes), never splitting the blob.
  for (let attempt = 0; attempt < 400 && count > target; attempt++) {
    const c = Math.floor(rng() * w);
    const r = Math.floor(rng() * h);
    if (!filled(c, r)) continue;
    let onEdge = false;
    let rimsHole = false;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (!filled(nc, nr)) {
        if (holes.has(idx(nc, nr))) rimsHole = true;
        else onEdge = true;
      }
    }
    if (!onEdge || rimsHole) continue;
    if (!removable(c, r)) continue;
    grid[idx(c, r)] = false;
    count--;
  }

  // Trim the box to the surviving cells.
  let minC = w;
  let maxC = -1;
  let minR = h;
  let maxR = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!grid[idx(c, r)]) continue;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
  }
  const rows: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    let row = '';
    for (let c = minC; c <= maxC; c++) row += grid[idx(c, r)] ? '1' : '0';
    rows.push(row);
  }
  const outW = maxC - minC + 1;
  const outH = maxR - minR + 1;
  const x0 = 1 + Math.floor(rng() * Math.max(1, fieldW - outW - 1));
  const z0 = 1 + Math.floor(rng() * Math.max(1, fieldD - outH - 1));
  return { x0, z0, w: outW, h: outH, rows };

  function isSealedInterior(c: number, r: number): boolean {
    if (!filled(c, r)) return false;
    return filled(c + 1, r) && filled(c - 1, r) && filled(c, r + 1) && filled(c, r - 1);
  }

  // Would the blob stay 4-connected without this cell?
  function removable(c: number, r: number): boolean {
    grid[idx(c, r)] = false;
    const ok = connected(grid, w, h);
    grid[idx(c, r)] = true;
    return ok;
  }
}

function connected(grid: boolean[], w: number, h: number): boolean {
  let start = -1;
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i]) {
      total++;
      if (start < 0) start = i;
    }
  }
  if (total === 0) return false;
  const seen = new Uint8Array(grid.length);
  const stack = [start];
  seen[start] = 1;
  let reached = 0;
  while (stack.length > 0) {
    const i = stack.pop()!;
    reached++;
    const c = i % w;
    const r = Math.floor(i / w);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
      const j = nr * w + nc;
      if (!grid[j] || seen[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return reached === total;
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- queries

// Is a continuous field position inside the shape? Cell (cx, cz) spans
// [cx, cx+1) × [cz, cz+1).
export function shapeContains(shape: TetrisShape, x: number, z: number): boolean {
  const c = Math.floor(x) - shape.x0;
  const r = Math.floor(z) - shape.z0;
  if (c < 0 || r < 0 || c >= shape.w || r >= shape.h) return false;
  return shape.rows[r].charCodeAt(c) === 49; // '1'
}

export function shapeCells(shape: TetrisShape): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 0; r < shape.h; r++) {
    for (let c = 0; c < shape.w; c++) {
      if (shape.rows[r][c] === '1') cells.push([shape.x0 + c, shape.z0 + r]);
    }
  }
  return cells;
}

export function shapeCellCount(shape: TetrisShape): number {
  let n = 0;
  for (const row of shape.rows) for (const ch of row) if (ch === '1') n++;
  return n;
}

// Sealed interior holes: 4-connected components of empty cells inside the
// box that never touch its border.
export function shapeHoles(shape: TetrisShape): number {
  const { w, h, rows } = shape;
  const seen = new Uint8Array(w * h);
  let holes = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (rows[r][c] === '1' || seen[r * w + c]) continue;
      let touchesBorder = false;
      const stack = [r * w + c];
      seen[r * w + c] = 1;
      while (stack.length > 0) {
        const i = stack.pop()!;
        const ic = i % w;
        const ir = Math.floor(i / w);
        if (ic === 0 || ir === 0 || ic === w - 1 || ir === h - 1) touchesBorder = true;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nc = ic + dc;
          const nr = ir + dr;
          if (nc < 0 || nr < 0 || nc >= w || nr >= h) continue;
          const j = nr * w + nc;
          if (rows[nr][nc] === '1' || seen[j]) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      if (!touchesBorder) holes++;
    }
  }
  return holes;
}

export function shapeConnected(shape: TetrisShape): boolean {
  const grid = shape.rows.flatMap((row) => [...row].map((ch) => ch === '1'));
  return connected(grid, shape.w, shape.h);
}
