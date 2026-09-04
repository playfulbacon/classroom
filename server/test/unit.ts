// White-box tests for TeamPuzzles internals: generalized gw x gh geometry,
// even team assignment with phantoms, and phantom relocation when another
// team locks on top of a phantom group's assembly area.
// Run with: npx tsx test/unit.ts   (also runs as part of `npm run smoke`)

import assert from 'node:assert/strict';
import type { StageSnapshot } from '../../shared/protocol';
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
    options: { rotation: false, puzzleW, puzzleH },
    isBot: () => true,
    imageIds: () => imageIds,
    emitStage: (s) => {
      snapshot = s;
    },
    emitMe: () => {},
    buzz: () => {},
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

console.log('\nUNIT PASS ✅');
