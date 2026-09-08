// Medusa field generation. The layout is a rhythm of full-width chasm bands
// crossed by ferry platforms, with exactly three crumbling cells spaced
// evenly along each ground segment between them (and the start/finish
// stretches). There are no scattered single pits — single pits only appear
// mid-round where crumbling ground has collapsed. Pits are deadly, so the
// flanking columns of every band stay clear and a post-generation BFS
// verifies the finish is reachable (band cells pass only on platform lanes).

export interface PlatformDef {
  id: number;
  lane: number;
  c0: number; // band start column (inclusive)
  c1: number; // band end column (inclusive)
  phase: number; // 0..1 starting offset along the shuttle run
}

export interface MedusaField {
  pits: Set<number>; // cellKey — every chasm band cell (nothing else)
  crumble: Set<number>; // crumble cell keys (all start intact)
  chasms: { c0: number; c1: number }[];
  platforms: PlatformDef[];
}

export function cellKey(col: number, lane: number, length: number): number {
  return lane * length + col;
}

function generateOnce(length: number, lanes: number, startCols: number): MedusaField {
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
    // Every ground segment (before, between, after the bands) must keep at
    // least 3 usable columns clear of the band-flank buffer, so the three
    // evenly spaced crumble cells always fit.
    c0 = Math.max(startCols + 5, Math.min(length - 3 - width, c0));
    const prev = chasms[chasms.length - 1];
    if (prev && c0 <= prev.c1 + 5) c0 = prev.c1 + 6;
    const c1 = Math.min(length - 7, c0 + width - 1);
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
  // Crumbling ground: exactly three cells per ground segment — the stretch
  // before the first band, between consecutive bands, and after the last —
  // spaced evenly along the segment's columns, each on a random lane. The
  // columns flanking a chasm stay completely clear (stepping off a ferry
  // must never land you against a hole), so segments end 2 columns short of
  // every band edge.
  let prevEnd = startCols; // the start zone itself stays clear
  const segments: [number, number][] = [];
  for (const band of chasms) {
    segments.push([prevEnd + 1, band.c0 - 2]);
    prevEnd = band.c1 + 1;
  }
  segments.push([prevEnd + 1, length - 3]);
  let lastCol = -9;
  let lastLane = -9;
  for (const [s0, s1] of segments) {
    const width = s1 - s0 + 1;
    if (width <= 0) continue;
    const count = Math.min(3, width);
    for (let i = 0; i < count; i++) {
      const col = s0 + Math.round(((width - 1) * i) / Math.max(1, count - 1));
      let lane = Math.floor(Math.random() * lanes);
      // Never orthogonally adjacent to the previous crumble cell.
      if (Math.abs(col - lastCol) <= 1 && lane === lastLane) lane = (lane + 1) % lanes;
      crumble.add(cellKey(col, lane, length));
      lastCol = col;
      lastLane = lane;
    }
  }

  return { pits, crumble, chasms, platforms };
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
