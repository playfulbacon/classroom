// Medusa field generation: scattered pits, full-width chasm bands crossed by
// ferry platforms, and crumbling ground. Nothing here is deadly — pits and
// collapsed cells BLOCK movement; petrification is the game's only
// elimination. Solvability is explicit: carved safe paths never receive pits
// or crumble (the permanent spine), and a post-generation BFS verifies the
// finish is reachable, treating band cells as passable only on platform lanes.

export interface PlatformDef {
  id: number;
  lane: number;
  c0: number; // band start column (inclusive)
  c1: number; // band end column (inclusive)
  phase: number; // 0..1 starting offset along the shuttle run
}

export interface MedusaField {
  pits: Set<number>; // cellKey — includes every chasm band cell
  crumble: Set<number>; // crumble cell keys (all start intact)
  chasms: { c0: number; c1: number }[];
  platforms: PlatformDef[];
  safe: Set<number>; // carved path cells (never pit/crumble) — used by tests
}

export function cellKey(col: number, lane: number, length: number): number {
  return lane * length + col;
}

function carveSafePaths(length: number, lanes: number): Set<number> {
  const safe = new Set<number>();
  const paths = 3 + Math.floor(Math.random() * 2);
  for (let p = 0; p < paths; p++) {
    let lane = Math.floor(Math.random() * lanes);
    for (let col = 0; col < length; col++) {
      safe.add(cellKey(col, lane, length));
      lane = Math.min(lanes - 1, Math.max(0, lane + (Math.floor(Math.random() * 3) - 1)));
      safe.add(cellKey(Math.min(col + 1, length - 1), lane, length));
    }
  }
  return safe;
}

function generateOnce(length: number, lanes: number, startCols: number): MedusaField {
  const safe = carveSafePaths(length, lanes);
  const pits = new Set<number>();
  const crumble = new Set<number>();

  // Chasm bands: full-width pit gorges that make the ferries mandatory.
  // Keep them clear of the start zone, the finish approach, and each other.
  const chasms: { c0: number; c1: number }[] = [];
  const bandCount = length >= 20 ? 2 : 1;
  for (let b = 0; b < bandCount; b++) {
    const width = 2 + Math.floor(Math.random() * 2);
    const center = Math.round(length * (bandCount === 1 ? 0.5 : 0.38 + b * 0.28));
    let c0 = center - Math.floor(width / 2) + Math.floor(Math.random() * 2);
    c0 = Math.max(startCols + 2, Math.min(length - 3 - width, c0));
    const prev = chasms[chasms.length - 1];
    if (prev && c0 <= prev.c1 + 2) c0 = prev.c1 + 3; // >=2 solid columns between
    const c1 = Math.min(length - 4, c0 + width - 1);
    if (c1 < c0) continue;
    chasms.push({ c0, c1 });
    for (let col = c0; col <= c1; col++) {
      for (let lane = 0; lane < lanes; lane++) pits.add(cellKey(col, lane, length));
    }
  }

  // Ferry platforms: a few per band on spread-out lanes, staggered phases.
  const platforms: PlatformDef[] = [];
  let nextId = 0;
  for (const band of chasms) {
    const count = Math.max(2, Math.ceil(lanes / 6));
    const used = new Set<number>();
    for (let i = 0; i < count; i++) {
      const target = Math.round(((i + 0.5) / count) * (lanes - 1));
      let lane = Math.max(0, Math.min(lanes - 1, target + Math.floor(Math.random() * 3) - 1));
      while (used.has(lane)) lane = (lane + 1) % lanes;
      used.add(lane);
      platforms.push({ id: nextId++, lane, c0: band.c0, c1: band.c1, phase: Math.random() });
    }
  }
  const inBand = (col: number) => chasms.some((b) => col >= b.c0 && col <= b.c1);

  // Scattered pits (blocking rocks) outside safe paths and bands.
  for (let col = startCols + 1; col <= length - 3; col++) {
    if (inBand(col)) continue;
    let inCol = 0;
    const cap = Math.floor(lanes * 0.35);
    for (let lane = 0; lane < lanes; lane++) {
      if (inCol >= cap) break;
      const k = cellKey(col, lane, length);
      if (safe.has(k)) continue;
      if (Math.random() < 0.18) {
        pits.add(k);
        inCol++;
      }
    }
  }

  // Crumbling ground: walkable shortcuts that collapse behind the crowd.
  // Never on the carved spine, never in a band, and never orthogonally
  // adjacent to a pit or another crumble cell — a collapse can then never
  // seal a neighboring cell's last exit.
  for (let col = startCols + 1; col <= length - 3; col++) {
    if (inBand(col)) continue;
    for (let lane = 0; lane < lanes; lane++) {
      const k = cellKey(col, lane, length);
      if (safe.has(k) || pits.has(k)) continue;
      const neighbors = [
        [col + 1, lane],
        [col - 1, lane],
        [col, lane + 1],
        [col, lane - 1],
      ];
      const badNeighbor = neighbors.some(([c, l]) => {
        if (c < 0 || c >= length || l < 0 || l >= lanes) return false;
        const nk = cellKey(c, l, length);
        return pits.has(nk) || crumble.has(nk);
      });
      if (!badNeighbor && Math.random() < 0.08) crumble.add(k);
    }
  }

  return { pits, crumble, chasms, platforms, safe };
}

// BFS from every start-zone cell to the finish column. Band cells count as
// passable on platform lanes (the ferry always comes around); intact crumble
// is walkable (and the carved spine never crumbles).
export function isSolvable(
  field: MedusaField,
  length: number,
  lanes: number,
  startCols: number,
): boolean {
  const platformLanes = (col: number): Set<number> => {
    const set = new Set<number>();
    for (const p of field.platforms) {
      if (col >= p.c0 && col <= p.c1) set.add(p.lane);
    }
    return set;
  };
  const seen = new Set<number>();
  const queue: number[] = [];
  for (let col = 0; col < startCols; col++) {
    for (let lane = 0; lane < lanes; lane++) {
      const k = cellKey(col, lane, length);
      if (!field.pits.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  while (queue.length > 0) {
    const cell = queue.shift()!;
    const c = cell % length;
    const l = Math.floor(cell / length);
    if (c === length - 1) return true;
    for (const [dc, dl] of [[1, 0], [0, -1], [0, 1], [-1, 0]] as const) {
      const nc = c + dc;
      const nl = l + dl;
      if (nc < 0 || nc >= length || nl < 0 || nl >= lanes) continue;
      const nk = cellKey(nc, nl, length);
      if (seen.has(nk)) continue;
      if (field.pits.has(nk) && !platformLanes(nc).has(nl)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return false;
}

export function generateField(length: number, lanes: number, startCols: number): MedusaField {
  let field = generateOnce(length, lanes, startCols);
  for (let attempt = 0; attempt < 10 && !isSolvable(field, length, lanes, startCols); attempt++) {
    field = generateOnce(length, lanes, startCols);
  }
  return field;
}
