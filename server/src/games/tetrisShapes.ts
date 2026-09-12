// Human Tetris shape generation: the safe zone the crowd has to fill before
// the wall drops. Every shape is a 4-connected blob of unit cells carved out
// of a random rectangle — bites out of the edges for an irregular outline,
// and true interior HOLES (empty cells sealed on all four sides) that the
// crowd has to flow around. Two families:
//
//   blob   — a compact shape with one to three small holes (sometimes none);
//   swiss  — a roomier box riddled with several bigger holes spread across
//            it, so the safe cells become corridors and islands and the
//            crowd has to scatter rather than huddle.
//
// The blob always holds at least `minCells` (one cell per person — cells
// are exclusive) so the round is physically possible, and it lands
// somewhere random on the field with a one-cell margin.

import type { TetrisShape } from '../../../shared/protocol';

type Rng = () => number;

export type ShapeFamily = 'blob' | 'swiss';

export function generateShape(
  fieldW: number,
  fieldD: number,
  minCells: number,
  rng: Rng = Math.random,
  family?: ShapeFamily,
): TetrisShape {
  const maxW = Math.max(1, fieldW - 2);
  const maxH = Math.max(1, fieldD - 2);
  const need = Math.max(1, Math.min(minCells, maxW * maxH));
  const kind: ShapeFamily = family ?? (need >= 10 && rng() < 0.45 ? 'swiss' : 'blob');

  // Plan the holes first so the box can be sized to hold them AND the
  // crowd. Swiss holes are rectangles up to 2x2 (the odd 3x1), several of
  // them; blob holes are one cell, sometimes grown to two.
  const holePlan: [number, number][] = [];
  if (kind === 'swiss') {
    const k = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < k; i++) {
      const r = rng();
      holePlan.push(r < 0.3 ? [1, 1] : r < 0.55 ? [2, 1] : r < 0.8 ? [1, 2] : r < 0.92 ? [2, 2] : [3, 1]);
    }
  } else if (rng() >= 0.2) {
    const k = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < k; i++) holePlan.push([1, 1]);
  }
  const holeCells = holePlan.reduce((n, [hw, hh]) => n + hw * hh, 0);

  // Bounding box: roomier than the requirement so there's material to
  // carve; a random aspect so shapes lie tall, wide or square.
  const roominess = kind === 'swiss' ? 1.25 + rng() * 0.3 : 1.45 + rng() * 0.55;
  const total = Math.ceil((need + holeCells) * roominess);
  let w = Math.round(Math.sqrt(total) * (0.75 + rng() * 0.9));
  w = Math.max(2, Math.min(maxW, w));
  let h = Math.ceil(total / w);
  h = Math.max(2, Math.min(maxH, h));
  if (w * h < need + holeCells) w = Math.min(maxW, Math.ceil((need + holeCells) / h));
  if (w * h < need + holeCells) h = Math.min(maxH, Math.ceil((need + holeCells) / w));

  const grid: boolean[] = new Array(w * h).fill(true);
  let count = w * h;
  const holes = new Set<number>();
  const idx = (c: number, r: number) => r * w + c;
  const filled = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h && grid[idx(c, r)];

  // Interior holes: a rectangle is sealed when it keeps one solid cell
  // from the box border and one from every other hole. On a solid box
  // that never breaks connectivity, so no BFS is needed here.
  const canHole = (c0: number, r0: number, hw: number, hh: number): boolean => {
    if (c0 < 1 || r0 < 1 || c0 + hw > w - 1 || r0 + hh > h - 1) return false;
    for (let r = r0 - 1; r <= r0 + hh; r++) {
      for (let c = c0 - 1; c <= c0 + hw; c++) {
        if (!filled(c, r)) return false;
      }
    }
    return true;
  };
  const punch = (c0: number, r0: number, hw: number, hh: number) => {
    for (let r = r0; r < r0 + hh; r++) {
      for (let c = c0; c < c0 + hw; c++) {
        grid[idx(c, r)] = false;
        holes.add(idx(c, r));
        count--;
      }
    }
  };
  for (const [hw, hh] of holePlan) {
    if (count - hw * hh < need) break;
    for (let attempt = 0; attempt < 40; attempt++) {
      const c0 = 1 + Math.floor(rng() * Math.max(1, w - 1 - hw));
      const r0 = 1 + Math.floor(rng() * Math.max(1, h - 1 - hh));
      if (!canHole(c0, r0, hw, hh)) continue;
      punch(c0, r0, hw, hh);
      // A blob hole sometimes grows by one cell (still sealed).
      if (kind === 'blob' && count > need && rng() < 0.4) {
        for (const [dc, dr] of shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]] as const, rng)) {
          const c2 = c0 + dc;
          const r2 = r0 + dr;
          if (!filled(c2, r2) || c2 < 1 || r2 < 1 || c2 > w - 2 || r2 > h - 2) continue;
          let sealed = true;
          for (const [ec, er] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nc = c2 + ec;
            const nr = r2 + er;
            if (nc === c0 && nr === r0) continue;
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

  // Then bites out of the outline down to the target size, never touching
  // a hole's rim (so holes stay holes), never splitting the blob.
  const target = Math.min(count, need + Math.floor(rng() * 2));
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
    grid[idx(c, r)] = false;
    if (!connected(grid, w, h)) {
      grid[idx(c, r)] = true;
      continue;
    }
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
  return shapeHasCell(shape, Math.floor(x), Math.floor(z));
}

export function shapeHasCell(shape: TetrisShape, cx: number, cz: number): boolean {
  const c = cx - shape.x0;
  const r = cz - shape.z0;
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
