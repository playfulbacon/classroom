// White-box tests for TeamPuzzles internals: generalized gw x gh geometry,
// even team assignment with phantoms, and phantom relocation when another
// team locks on top of a phantom group's assembly area.
// Run with: npx tsx test/unit.ts   (also runs as part of `npm run smoke`)

import assert from 'node:assert/strict';
import type { StageSnapshot } from '../../shared/protocol';
import { Medusa } from '../src/games/medusa';
import { cellKey, generateField } from '../src/games/medusaField';
import { TeamPuzzles } from '../src/games/teamPuzzles';
import type { GameCtx } from '../src/games/types';

interface Ctl {
  game: TeamPuzzles;
  internals: any;
}

function makeGame(
  playerCount: number,
  puzzleW: number,
  puzzleH: number,
  imageIds: string[] = [],
): Ctl {
  let snapshot: StageSnapshot | null = null;
  const ctx: GameCtx = {
    slots: () =>
      Array.from({ length: playerCount }, (_, i) => ({
        slot: i + 1,
        name: `P${i + 1}`,
        color: 'red',
      })),
    options: { rotation: false, puzzleW, puzzleH, medusaEyes: false },
    isBot: () => true,
    imageIds: () => imageIds,
    emitStage: (s) => {
      snapshot = s;
    },
    emitMe: () => {},
    buzz: () => {},
    send: () => {},
  };
  const game = new TeamPuzzles(ctx);
  const internals = game as any;
  internals.layout();
  void snapshot;
  return { game, internals };
}

function qx(q: number, gw: number) {
  return q % gw;
}
function qy(q: number, gw: number) {
  return Math.floor(q / gw);
}

// Move a piece to an absolute cell via the real grid bookkeeping.
function teleport(internals: any, piece: any, cx: number, cy: number) {
  assert.equal(internals.grid[cy][cx], null, `cell (${cx},${cy}) not free`);
  internals.grid[piece.cy][piece.cx] = null;
  piece.cx = cx;
  piece.cy = cy;
  internals.grid[cy][cx] = piece;
}

// ---------------------------------------------------------------------------
// Even team assignment + phantom counts, across sizes and class sizes
// ---------------------------------------------------------------------------
for (const [n, w, h] of [
  [5, 2, 2],
  [10, 3, 2],
  [70, 2, 2],
  [70, 3, 3],
  [7, 1, 4],
  [2, 2, 1],
  [70, 5, 5],
] as const) {
  const { internals } = makeGame(n, w, h);
  const K = w * h;
  const groupCount = internals.groupCount as number;
  assert.equal(groupCount, Math.max(1, Math.ceil(n / K)), `groups for n=${n} ${w}x${h}`);
  const pieces = internals.pieces as any[];
  assert.equal(pieces.length, groupCount * K, `piece count for n=${n} ${w}x${h}`);
  const phantoms = pieces.filter((p) => p.id < 0);
  assert.equal(phantoms.length, groupCount * K - n, `phantom count for n=${n} ${w}x${h}`);
  for (let g = 0; g < groupCount; g++) {
    const members = pieces.filter((p) => p.g === g);
    assert.equal(members.length, K, `group ${g} size`);
    const quads = new Set(members.map((p) => p.q));
    assert.equal(quads.size, K, `group ${g} has one piece per position`);
    const humans = members.filter((p) => p.slot !== null).length;
    // Even spread: player counts differ by at most 1 across groups.
    assert.ok(
      humans >= Math.floor(n / groupCount) && humans <= Math.ceil(n / groupCount),
      `group ${g} player count ${humans} uneven for n=${n} ${w}x${h}`,
    );
    // All phantoms of a group agree on one origin (mutually consistent).
    const groupPhantoms = members.filter((p) => p.id < 0);
    const origins = new Set(
      groupPhantoms.map((p) => `${p.cx - qx(p.q, w)},${p.cy - qy(p.q, w)}`),
    );
    assert.ok(origins.size <= 1, `group ${g} phantoms scattered`);
    for (const p of groupPhantoms) assert.ok(p.locked, 'phantoms start locked');
  }
}
console.log('unit: team assignment + phantoms OK');

// ---------------------------------------------------------------------------
// Snap detection for a non-square puzzle (3x2)
// ---------------------------------------------------------------------------
{
  const { internals } = makeGame(6, 3, 2, ['img-a', 'img-b']);
  internals.phase = 'play';
  const pieces = internals.pieces as any[];
  assert.equal(internals.groupCount, 1);
  assert.deepEqual(internals.groupImages, ['img-a'], 'first group gets first image');
  // Clear the board mapping and rebuild the assembly at (2,1) by hand.
  const ox = 2;
  const oy = 1;
  for (const p of pieces) {
    // free target cell first if some other piece is sitting there
    const tx = ox + qx(p.q, 3);
    const ty = oy + qy(p.q, 3);
    if (p.cx === tx && p.cy === ty) continue; // already in place
    const blocker = internals.grid[ty][tx];
    if (blocker && blocker !== p) {
      // move blocker far away to a free cell
      outer: for (let y = internals.rows - 1; y >= 0; y--) {
        for (let x = internals.cols - 1; x >= 0; x--) {
          if (!internals.grid[y][x]) {
            teleport(internals, blocker, x, y);
            break outer;
          }
        }
      }
    }
    teleport(internals, p, tx, ty);
  }
  internals.checkSnap(0);
  assert.deepEqual(internals.finished, [0], '3x2 group snapped');
  assert.ok(pieces.every((p: any) => p.locked));
}
console.log('unit: 3x2 snap detection OK');

// ---------------------------------------------------------------------------
// Phantom relocation when another team locks on the phantom area
// ---------------------------------------------------------------------------
{
  // 5 players, 2x2 → 2 groups (3 + 2 players), each with phantoms. Construct
  // the blocked-phantom scenario deterministically: put group 1's phantoms at
  // a known interior origin, then lock group 0 overlapping a free cell of
  // that area.
  const { internals } = makeGame(5, 2, 2);
  internals.phase = 'play';
  const pieces = internals.pieces as any[];
  const g1Phantoms = pieces.filter((p: any) => p.id < 0 && p.g === 1);
  assert.ok(g1Phantoms.length >= 1, 'group 1 has phantoms');

  const parkFar = (p: any, avoid: (x: number, y: number) => boolean) => {
    for (let y = internals.rows - 1; y >= 0; y--) {
      for (let x = internals.cols - 1; x >= 0; x--) {
        if (!internals.grid[y][x] && !avoid(x, y)) {
          teleport(internals, p, x, y);
          return;
        }
      }
    }
    throw new Error('no free scratch cell');
  };

  // Group 1's phantom area at (3,2)-(4,3) — interior on every board size.
  const p1ox = 3;
  const p1oy = 2;
  const inG1Area = (x: number, y: number) =>
    x >= p1ox && x < p1ox + 2 && y >= p1oy && y < p1oy + 2;
  const nearG1 = (x: number, y: number) =>
    x >= p1ox - 2 && x < p1ox + 4 && y >= p1oy - 2 && y < p1oy + 4;
  // Move group 0's phantom out of the neighbourhood so it can't block the
  // candidate origins below (it rejoins its group at the chosen area later).
  for (const p of pieces.filter((p2: any) => p2.id < 0 && p2.g === 0)) {
    if (nearG1(p.cx, p.cy)) parkFar(p, nearG1);
  }
  for (const phantom of g1Phantoms) {
    const tx = p1ox + qx(phantom.q, 2);
    const ty = p1oy + qy(phantom.q, 2);
    const blocker = internals.grid[ty][tx];
    if (blocker && blocker !== phantom) parkFar(blocker, inG1Area);
    if (phantom.cx !== tx || phantom.cy !== ty) teleport(internals, phantom, tx, ty);
  }

  // Pick a free cell of the area and a 2x2 origin for group 0 covering it
  // while avoiding the phantoms (one of the four candidate origins always
  // works for an interior area with ≤3 phantoms).
  const freeCell = [0, 1, 2, 3]
    .map((q) => [p1ox + qx(q, 2), p1oy + qy(q, 2)] as const)
    .find(([x, y]) => !internals.grid[y][x]?.locked);
  assert.ok(freeCell, 'group 1 area has a free cell');
  const [fx, fy] = freeCell!;
  let chosen: [number, number] | null = null;
  for (const [ox, oy] of [
    [fx, fy],
    [fx - 1, fy],
    [fx, fy - 1],
    [fx - 1, fy - 1],
  ] as const) {
    if (ox < 0 || oy < 0 || ox + 1 >= internals.cols || oy + 1 >= internals.rows) continue;
    let ok = true;
    for (let q = 0; q < 4; q++) {
      if (internals.grid[oy + qy(q, 2)][ox + qx(q, 2)]?.locked) ok = false;
    }
    if (ok) {
      chosen = [ox, oy];
      break;
    }
  }
  assert.ok(chosen, 'found an overlapping origin for group 0');
  const inChosen = (x: number, y: number) =>
    x >= chosen![0] && x < chosen![0] + 2 && y >= chosen![1] && y < chosen![1] + 2;
  // Clear the chosen area of movable strangers, park group 0 on scratch
  // cells, then drop each piece onto its final cell.
  const group0 = pieces.filter((p: any) => p.g === 0);
  for (let q = 0; q < 4; q++) {
    const cell = internals.grid[chosen[1] + qy(q, 2)][chosen[0] + qx(q, 2)];
    if (cell && !cell.locked) parkFar(cell, (x, y) => inChosen(x, y) || inG1Area(x, y));
  }
  for (const p of group0) {
    if (inChosen(p.cx, p.cy)) continue;
    parkFar(p, (x, y) => inChosen(x, y) || inG1Area(x, y));
  }
  for (const p of group0) {
    const tx = chosen[0] + qx(p.q, 2);
    const ty = chosen[1] + qy(p.q, 2);
    if (p.cx !== tx || p.cy !== ty) teleport(internals, p, tx, ty);
  }
  internals.checkSnap(0);
  assert.deepEqual(internals.finished, [0], 'group 0 locked over the phantom area');

  // Tick past the phantom check; the blocked phantoms must move.
  for (let i = 0; i < 20; i++) internals.tick(1 / 15);
  const moved = pieces.filter((p: any) => p.id < 0 && p.g === 1);
  const nox = moved[0].cx - qx(moved[0].q, 2);
  const noy = moved[0].cy - qy(moved[0].q, 2);
  for (const p of moved) {
    assert.equal(p.cx - qx(p.q, 2), nox, 'relocated phantoms consistent');
    assert.equal(p.cy - qy(p.q, 2), noy, 'relocated phantoms consistent');
  }
  // New area must not contain group 0's locked pieces.
  for (let q = 0; q < 4; q++) {
    const cell = internals.grid[noy + qy(q, 2)][nox + qx(q, 2)];
    assert.ok(!cell || cell.g === 1, 'new phantom area clear of locked pieces');
  }
  assert.ok(nox !== p1ox || noy !== p1oy, 'phantom origin actually changed');
}
console.log('unit: phantom relocation OK');

// ---------------------------------------------------------------------------
// Medusa
// ---------------------------------------------------------------------------

function makeMedusa(playerCount: number, medusaEyes = false) {
  const buzzes: [number, string][] = [];
  const ctx: GameCtx = {
    slots: () =>
      Array.from({ length: playerCount }, (_, i) => ({
        slot: i + 1,
        name: `P${i + 1}`,
        color: 'red',
      })),
    options: { rotation: false, puzzleW: 2, puzzleH: 2, medusaEyes },
    isBot: () => true,
    imageIds: () => [],
    emitStage: () => {},
    emitMe: () => {},
    buzz: (slot, type) => buzzes.push([slot, type]),
    send: () => {},
  };
  const game = new Medusa(ctx);
  game.start();
  game.dispose(); // stop the interval; we drive ticks by hand
  const internals = game as any;
  internals.phase = 'play';
  return { game, internals, buzzes };
}

// (a) Every generated field is traversable (independent BFS: pit cells pass
// only on ferry-route lanes) and respects the layout invariants: crumble
// never on the carved spine, never beside a pit or another crumble, and
// every chasm band carries at least two ferries.
{
  const L = 24;
  const lanes = 16;
  const startCols = 2;
  for (let seed = 0; seed < 30; seed++) {
    const field = generateField(L, lanes, startCols);
    const ferryLane = (c: number, l: number) =>
      field.platforms.some((p) => p.lane === l && c >= p.c0 && c <= p.c1);
    const visited = new Set<number>();
    const queue: [number, number][] = [];
    for (let lane = 0; lane < lanes; lane++) {
      queue.push([0, lane]);
      visited.add(cellKey(0, lane, L));
    }
    let reached = false;
    while (queue.length > 0 && !reached) {
      const [col, lane] = queue.shift()!;
      if (col === L - 1) {
        reached = true;
        break;
      }
      for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nl = lane + dl;
        if (nc < 0 || nc >= L || nl < 0 || nl >= lanes) continue;
        const key = cellKey(nc, nl, L);
        if (visited.has(key)) continue;
        if (field.pits.has(key) && !ferryLane(nc, nl)) continue;
        visited.add(key);
        queue.push([nc, nl]);
      }
    }
    assert.ok(reached, `seed ${seed}: no traversable path to the finish`);

    for (const k of field.crumble) {
      assert.ok(!field.safe.has(k), `seed ${seed}: crumble on a carved safe path`);
      assert.ok(!field.pits.has(k), `seed ${seed}: crumble on a pit`);
      const c = k % L;
      const l = Math.floor(k / L);
      for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = c + dc;
        const nl = l + dl;
        if (nc < 0 || nc >= L || nl < 0 || nl >= lanes) continue;
        const nk = cellKey(nc, nl, L);
        assert.ok(
          !field.pits.has(nk) && !field.crumble.has(nk),
          `seed ${seed}: crumble at (${c},${l}) touches a pit/crumble neighbor`,
        );
      }
    }
    assert.ok(field.chasms.length >= 1, `seed ${seed}: no chasm bands`);
    for (const band of field.chasms) {
      const ferries = field.platforms.filter((p) => p.c0 === band.c0 && p.c1 === band.c1);
      assert.ok(ferries.length >= 2, `seed ${seed}: band needs >=2 ferries`);
      // Stepping off a ferry (either bank) must never land against a pit.
      for (const col of [band.c0 - 1, band.c1 + 1]) {
        for (let lane = 0; lane < lanes; lane++) {
          const k = cellKey(col, lane, L);
          assert.ok(
            !field.pits.has(k) && !field.crumble.has(k),
            `seed ${seed}: obstacle beside a chasm at (${col},${lane})`,
          );
        }
      }
    }
  }
}
console.log('unit: medusa fields always solvable (chasms, ferries, crumble) OK');

// (b) Gaze fairness: turning safe, early red forgiven, late red petrifies;
// (c) hop cooldown; (d) pits block instead of killing; (e) timeout petrifies
// stragglers.
{
  const { game, internals } = makeMedusa(4);
  const clearCell = (col: number, lane: number) => {
    internals.pits.delete(lane * 24 + col);
    internals.crumbleStage.delete(lane * 24 + col);
  };
  const runner = internals.runners.get(1);
  runner.col = 5;
  runner.lane = 3;
  clearCell(6, 3); // ensure forward cell is open ground
  internals.t = 10;

  // turning is safe
  internals.gaze = 'turning';
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(runner.col, 6, 'hop during turning should move');
  assert.equal(runner.state, 0, 'turning must be safe');

  // cooldown: immediate second hop ignored
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(runner.col, 6, 'hop inside cooldown must be ignored');

  // early red is forgiven (grace)
  internals.t = 11;
  internals.gaze = 'red';
  internals.redSince = 11 - 0.2;
  clearCell(7, 3);
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(runner.col, 7, 'hop 200ms into red is forgiven');
  assert.equal(runner.state, 0);

  // late red petrifies in place
  internals.t = 12;
  internals.redSince = 12 - 0.5;
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(runner.state, 1, 'hop 500ms into red petrifies');
  assert.equal(runner.col, 7, 'petrified where they stood — the hop never lands');

  // pits BLOCK — nobody falls anywhere, the hop is just refused
  const r2 = internals.runners.get(2);
  r2.col = 5;
  r2.lane = 2;
  internals.pits.add(2 * 24 + 6);
  internals.t = 13;
  internals.gaze = 'green';
  game.input(2, { t: 'hop', d: 'f' });
  assert.equal(r2.col, 5, 'hop into a pit is refused — position unchanged');
  assert.equal(r2.state, 0, 'nothing on the field is deadly');

  // finishing
  const r3 = internals.runners.get(3);
  r3.col = 22;
  r3.lane = 4;
  clearCell(23, 4);
  internals.t = 14;
  game.input(3, { t: 'hop', d: 'f' });
  assert.equal(r3.state, 2, 'reaching the last column finishes');
  assert.deepEqual(internals.finished, [3]);
  assert.equal((game.personal(3) as any).placement, 1);

  // timeout: the final gaze petrifies everyone still running
  internals.t = internals.gazeUntil = 89.99;
  internals.tick(0.05);
  const r4 = internals.runners.get(4);
  assert.equal(r4.state, 1, 'timeout petrifies stragglers');
  assert.equal(internals.phase, 'over');
}
console.log('unit: medusa gaze/cooldown/pit-block/timeout OK');

// Ferry platforms: board only when aligned, ride across, step off; open
// water refuses the hop.
{
  const { game, internals } = makeMedusa(2);
  const key = (c: number, l: number) => l * 24 + c;
  // Hand-built gorge at cols 8-10 on every lane, one ferry on lane 3.
  internals.gaze = 'green';
  internals.gazeUntil = 1e9;
  for (let c = 8; c <= 10; c++) {
    for (let l = 0; l < internals.lanes; l++) internals.pits.add(key(c, l));
  }
  internals.platforms = [{ id: 7, lane: 3, c0: 8, c1: 10, pos: 9, dir: 1 }];
  internals.crumbleStage.clear();
  internals.pits.delete(key(7, 3));
  internals.pits.delete(key(11, 3));

  const r = internals.runners.get(1);
  r.col = 7;
  r.lane = 3;
  internals.t = 10;
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(r.col, 7, 'ferry mid-gorge: boarding hop refused');
  assert.equal(r.ride, null);

  internals.platforms[0].pos = 8.2; // docked within ALIGN_EPS of col 8
  internals.t = 11;
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(r.col, 8, 'aligned ferry accepts the boarding hop');
  assert.equal(r.ride, 7, 'boarding sets the ride');

  // The ferry carries the rider (tick moves pos, rider follows round(pos)).
  internals.platforms[0].pos = 8;
  internals.platforms[0].dir = 1;
  internals.t = 12;
  // 26 ticks × 0.05s × 1.6 cells/s ≥ the 2-cell crossing (it clamps at c1).
  for (let i = 0; i < 26; i++) internals.tick(1 / 20);
  assert.equal(r.col, 10, 'rider carried to the far side of the gorge');
  assert.equal(r.state, 0, 'riding is safe');

  internals.t += 1;
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(r.col, 11, 'stepping off onto the far bank');
  assert.equal(r.ride, null, 'dismount clears the ride');
}
console.log('unit: medusa ferry platforms OK');

// Crumbling ground: cracks underfoot, collapses only after it's vacated,
// then blocks like any pit.
{
  const { game, internals } = makeMedusa(2);
  const k = 5 * 24 + 10; // cell (10, 5)
  internals.gaze = 'green';
  internals.gazeUntil = 1e9;
  internals.pits.delete(k);
  internals.pits.delete(5 * 24 + 11);
  internals.crumbleStage.clear();
  internals.crumbleStage.set(k, 0);

  const r = internals.runners.get(1);
  r.col = 9;
  r.lane = 5;
  internals.pits.delete(5 * 24 + 9);
  internals.t = 10;
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(r.col, 10, 'intact crumble is walkable');
  assert.equal(internals.crumbleStage.get(k), 1, 'stepping on it cracks it');

  // Standing on the cracked cell forever: it must never collapse underfoot.
  internals.t = 11;
  for (let i = 0; i < 30; i++) internals.tick(1 / 20);
  assert.equal(internals.crumbleStage.get(k), 1, 'never collapses while occupied');
  assert.equal(r.state, 0);

  // Leave — it caves in shortly after.
  game.input(1, { t: 'hop', d: 'f' });
  assert.equal(r.col, 11);
  for (let i = 0; i < 20; i++) internals.tick(1 / 20); // 1s > 0.6s delay
  assert.equal(internals.crumbleStage.get(k), 2, 'collapses after being vacated');

  // Collapsed ground now blocks.
  internals.t += 1;
  game.input(1, { t: 'hop', d: 'b' });
  assert.equal(r.col, 11, 'hop onto collapsed ground refused');
}
console.log('unit: medusa crumbling ground OK');

// v2 gaze meter: her gaze fills a per-player meter (caught fast, unknown
// slow), safety drains it, full = statue; only provable CAUGHT raises the
// stone tiers; movement is never the crime.
{
  // Toggle off → gaze inputs are inert.
  {
    const { game, internals } = makeMedusa(2, false);
    game.input(1, { t: 'gaze', s: 1, c: 0.9 });
    assert.equal(internals.runners.get(1).gzAt, -Infinity, 'gaze inert when off');
  }

  const centerLaneOf = (internals: any) => Math.floor((internals.lanes - 1) / 2);
  // Position a runner mid-field on the center line: always inside the
  // sweeping cone, so meter math is deterministic.
  const place = (internals: any, slot: number, col = 5) => {
    const r = internals.runners.get(slot);
    r.col = col;
    r.lane = centerLaneOf(internals);
    return r;
  };
  const holdRed = (internals: any, t: number) => {
    internals.t = t;
    internals.gaze = 'red';
    internals.gazeUntil = t + 1000;
    internals.redSince = t - 2; // well past RED_START_GRACE
  };
  // Tick n times, refreshing a gaze report so it never goes stale.
  const run = (game: Medusa, internals: any, slot: number, s: number, c: number, n: number) => {
    for (let i = 0; i < n; i++) {
      if (i % 8 === 0) game.input(slot, { t: 'gaze', s: s as 1 | 2 | 3, c });
      internals.tick(1 / 20);
    }
  };

  // (a) CAUGHT fills in ~1s, raising tiers 1 and 2 on the way (with buzzes).
  {
    const { game, internals, buzzes } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    run(game, internals, 1, 2, 0.9, 16); // 0.8s of caught
    assert.equal(r.state, 0, 'still flesh at 0.8s');
    assert.ok(r.meter > 0.7 && r.meter < 0.9, `caught fill rate (meter ${r.meter})`);
    assert.equal(r.tier, 2, 'crossed both tier thresholds');
    assert.ok(buzzes.some(([slot, type]) => slot === 1 && type === 'creep'), 'creep buzz');
    run(game, internals, 1, 2, 0.9, 6);
    assert.equal(r.state, 1, 'meter full → statue');
  }

  // (b) UNKNOWN (no camera) fills at the slow-death rate — and never tiers.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    for (let i = 0; i < 20; i++) internals.tick(1 / 20); // 1s, no reports ever
    assert.ok(r.meter > 0.33 && r.meter < 0.47, `unknown fill rate (meter ${r.meter})`);
    assert.equal(r.tier, 0, 'uncertainty never slows — tier stays 0');
    for (let i = 0; i < 35; i++) internals.tick(1 / 20);
    assert.equal(r.state, 1, 'hiding from the camera is a slow death');
    void game;
  }

  // (c) Safe states drain the meter and tiers fall with hysteresis.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    r.meter = 0.95;
    r.tier = 2;
    run(game, internals, 1, 1, 0.9, 8); // 0.4s of eyes closed
    assert.ok(r.meter > 0.6 && r.meter < 0.75, `safe drain rate (meter ${r.meter})`);
    assert.equal(r.tier, 2, 'hysteresis: tier 2 holds above the 0.6 exit');
    run(game, internals, 1, 1, 0.9, 14);
    assert.ok(r.meter < 0.3, 'drained on');
    assert.equal(r.tier, 0, 'tiers fell through their exits');
    assert.equal(r.state, 0, 'redemption is possible');
  }

  // (d) Start-of-red fairness grace: the meter holds still.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    internals.t = 10;
    internals.gaze = 'red';
    internals.gazeUntil = 1000;
    internals.redSince = 10 - 0.2; // fresh red
    run(game, internals, 1, 2, 0.9, 8); // 0.4s caught, still inside 0.8s grace
    assert.equal(r.meter, 0, 'meter frozen during the fairness grace');
  }

  // (e) Low-confidence CAUGHT degrades to UNKNOWN: slow fill, no tier.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    run(game, internals, 1, 2, 0.3, 20); // caught but c < 0.6
    assert.ok(r.meter > 0.3 && r.meter < 0.5, `degraded fill (meter ${r.meter})`);
    assert.equal(r.tier, 0, 'no tier from borderline frames');
  }

  // (f) Eyes-closed linger: a closed report holds through a tracking gap
  // (heads tilt out of frame), then decays to UNKNOWN.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    r.meter = 0.5;
    game.input(1, { t: 'gaze', s: 1, c: 0.9 }); // closed, then silence
    for (let i = 0; i < 24; i++) internals.tick(1 / 20); // 1.2s: stale but lingering
    assert.ok(r.meter < 0.5, 'closed linger still drains through the gap');
    const after = r.meter;
    // The linger runs from the LAST closed sighting (~t+0.8), so give it
    // 1.6s more to expire and then fill.
    for (let i = 0; i < 32; i++) internals.tick(1 / 20);
    assert.ok(r.meter > after, 'linger expired → unknown fills again');
  }

  // (g) Statue cover: a statue between the eye and a caught runner blocks
  // the gaze — the meter holds instead of filling.
  {
    const { game, internals } = makeMedusa(3, true);
    const cover = place(internals, 2, 18);
    cover.state = 1; // hand-placed statue on the sight line
    internals.shadowDirty = true;
    const r = place(internals, 1, 10);
    holdRed(internals, 10);
    run(game, internals, 1, 2, 0.9, 20); // 1s of caught — but occluded
    assert.equal(r.meter, 0, 'behind a statue her gaze never lands');
    assert.equal(r.state, 0);
  }

  // (h) Movement is never the fail condition in v2: a caught runner may
  // still hop during deep red — the meter is what kills, not the hop.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    holdRed(internals, 10);
    game.input(1, { t: 'gaze', s: 2, c: 0.9 });
    internals.tick(1 / 20);
    internals.pits.delete(r.lane * 24 + 6);
    internals.crumbleStage.delete(r.lane * 24 + 6);
    game.input(1, { t: 'hop', d: 'f' });
    assert.equal(r.col, 6, 'hop lands during red in v2');
    assert.equal(r.state, 0, 'the hop itself never petrifies');
  }

  // (i) Stone slows: tiers stretch the hop cooldown.
  {
    const { game, internals } = makeMedusa(2, true);
    const r = place(internals, 1);
    internals.gaze = 'green';
    internals.gazeUntil = 1000;
    internals.t = 10;
    r.tier = 1; // cooldown 0.36s
    const cell = (c: number) => {
      internals.pits.delete(r.lane * 24 + c);
      internals.crumbleStage.delete(r.lane * 24 + c);
    };
    cell(6);
    cell(7);
    game.input(1, { t: 'hop', d: 'f' });
    assert.equal(r.col, 6);
    internals.t = 10.25; // inside the tier-1 cooldown
    game.input(1, { t: 'hop', d: 'f' });
    assert.equal(r.col, 6, 'tier-1 cooldown swallows the hop');
    internals.t = 10.4;
    game.input(1, { t: 'hop', d: 'f' });
    assert.equal(r.col, 7, 'and releases after 0.36s');
  }
}
console.log('unit: medusa v2 gaze meter OK');

console.log('\nUNIT PASS ✅');
