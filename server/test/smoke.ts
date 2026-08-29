// End-to-end smoke test: spins up the real server, connects a stage plus a
// classroom of simulated phones over real sockets, and plays both games.
//   - Last One Standing: bots joystick outward until everyone falls off and
//     the round produces placements.
//   - Team Puzzles: bots read the stage snapshot and steer their pieces into
//     their group's 2x2 arrangement until every group locks.
// Run with: npm run smoke

import { spawn, type ChildProcess } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import type {
  JoinResponse,
  LosSnapshot,
  MeState,
  PuzzleSnapshot,
  RoomState,
  StageSnapshot,
} from '../../shared/protocol';

const PORT = 4123;
const BASE_URL = `http://localhost:${PORT}`;
const NUM_PLAYERS = 12;

let serverProc: ChildProcess | null = null;
const sockets: Socket[] = [];

function fail(msg: string): never {
  console.error(`\nSMOKE FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  for (const s of sockets) s.disconnect();
  if (serverProc?.pid) {
    try {
      process.kill(-serverProc.pid, 'SIGKILL');
    } catch {
      serverProc.kill('SIGKILL');
    }
  }
}

function connect(): Socket {
  const s = io(BASE_URL, { transports: ['websocket'] });
  sockets.push(s);
  return s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(desc: string, timeoutMs: number, poll: () => T | null): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = poll();
    if (v !== null) return v;
    if (Date.now() - start > timeoutMs) fail(`timed out waiting for ${desc}`);
    await sleep(50);
  }
}

async function startServer() {
  serverProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true, // own process group so cleanup can kill npx + tsx together
  });
  let ready = false;
  serverProc.stdout?.on('data', (d: Buffer) => {
    if (d.toString().includes('listening')) ready = true;
  });
  await waitFor('server to listen', 15000, () => (ready ? true : null));
}

interface Bot {
  socket: Socket;
  slot: number;
  token: string;
  me: MeState | null;
}

async function main() {
  await startServer();
  console.log('server up');

  // --- Stage creates a room -------------------------------------------------
  const stage = connect();
  let latestSnapshot: StageSnapshot | null = null;
  let latestRoom: RoomState | null = null;
  stage.on('snapshot', (s: StageSnapshot) => {
    latestSnapshot = s;
  });
  stage.on('room', (r: RoomState) => {
    latestRoom = r;
  });
  const code = await new Promise<string>((resolve) => {
    stage.emit('stage:create', (res: { code: string }) => resolve(res.code));
  });
  if (!/^[A-Z2-9]{4}$/.test(code)) fail(`bad room code: ${code}`);
  console.log(`room ${code} created`);

  // --- Players join ---------------------------------------------------------
  const bots: Bot[] = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const s = connect();
    const bot: Bot = { socket: s, slot: 0, token: '', me: null };
    s.on('me', (me: MeState) => {
      bot.me = me;
    });
    const res = await new Promise<JoinResponse>((resolve) => {
      s.emit('join', { code, name: `Bot${i + 1}` }, resolve);
    });
    if (!res.ok || !res.playerId) fail(`join failed for bot ${i}: ${res.err}`);
    bot.slot = res.playerId;
    bot.token = res.token ?? '';
    bots.push(bot);
  }
  console.log(`${bots.length} players joined`);

  // --- Reconnect keeps the same slot ---------------------------------------
  {
    const first = bots[0];
    const res = await new Promise<JoinResponse>((resolve) => {
      first.socket.emit('join', { code, name: 'Bot1', token: first.token }, resolve);
    });
    if (res.playerId !== first.slot) fail('reconnect with token changed the player slot');
  }
  console.log('reconnect-to-slot OK');

  // ==========================================================================
  // Game 1: Last One Standing
  // ==========================================================================
  stage.emit('host:start', { game: 'los' });
  await waitFor('LOS countdown snapshot', 5000, () =>
    latestSnapshot?.kind === 'los' ? true : null,
  );

  await waitFor('LOS play phase', 8000, () =>
    latestSnapshot?.kind === 'los' && latestSnapshot.phase === 'play' ? true : null,
  );
  console.log('LOS: play phase reached');

  // Verify movement: everyone pushes outward (suicide run), so positions
  // must change and eliminations must follow.
  const posBefore = new Map<number, [number, number]>();
  for (const [slot, x, y] of (latestSnapshot as unknown as LosSnapshot).players) {
    posBefore.set(slot, [x, y]);
  }
  const pushOutward = setInterval(() => {
    const snap = latestSnapshot as LosSnapshot | null;
    if (!snap || snap.kind !== 'los') return;
    const pos = new Map(snap.players.map((p) => [p[0], p] as const));
    for (const bot of bots) {
      const p = pos.get(bot.slot);
      if (!p || !p[3]) continue;
      const mag = Math.hypot(p[1], p[2]) || 1;
      bot.socket.emit('input', { t: 'joy', x: p[1] / mag, y: p[2] / mag });
    }
  }, 100);

  await sleep(1200);
  {
    const snap = latestSnapshot as unknown as LosSnapshot;
    let moved = 0;
    for (const [slot, x, y] of snap.players) {
      const before = posBefore.get(slot);
      if (before && Math.hypot(x - before[0], y - before[1]) > 20) moved++;
    }
    if (moved < NUM_PLAYERS / 2) fail(`joystick input not moving players (moved=${moved})`);
    console.log(`LOS: ${moved} players moving under input`);
  }

  const overSnap = await waitFor('LOS round to end', 30000, () => {
    const snap = latestSnapshot as LosSnapshot | null;
    return snap?.kind === 'los' && snap.phase === 'over' ? snap : null;
  });
  clearInterval(pushOutward);
  if (overSnap.placements.length !== NUM_PLAYERS) {
    fail(`placements has ${overSnap.placements.length} entries, expected ${NUM_PLAYERS}`);
  }
  if (new Set(overSnap.placements).size !== NUM_PLAYERS) fail('placements contain duplicates');
  const eliminatedBot = bots.find((b) => b.me?.game === 'los' && b.me.alive === false);
  if (!eliminatedBot) fail('no bot received an eliminated me-state');
  console.log(`LOS: round over, winner slot ${overSnap.placements[0]}`);

  // ==========================================================================
  // Game 2: Team Puzzles
  // ==========================================================================
  stage.emit('host:start', { game: 'puzzle', options: { rotation: false } });
  await waitFor('puzzle snapshot', 5000, () =>
    latestSnapshot?.kind === 'puzzle' ? true : null,
  );
  await waitFor('puzzle play phase', 8000, () =>
    latestSnapshot?.kind === 'puzzle' && latestSnapshot.phase === 'play' ? true : null,
  );
  const firstPuzzle = latestSnapshot as unknown as PuzzleSnapshot;
  console.log(
    `puzzle: ${firstPuzzle.groupCount} groups on a ${firstPuzzle.cols}x${firstPuzzle.rows} board`,
  );
  for (const bot of bots) {
    if (bot.me?.game !== 'puzzle' || bot.me.group === undefined) {
      fail(`bot ${bot.slot} has no puzzle assignment`);
    }
  }

  // Bots steer toward per-group 2x2 anchors using BFS around occupied cells
  // (greedy straight-line seeking deadlocks against parked pieces; a student
  // looking at the board would just steer around them).
  const QUAD_DX = [0, 1, 0, 1];
  const QUAD_DY = [0, 0, 1, 1];
  const bfsStep = (
    snap: PuzzleSnapshot,
    occupied: Set<number>,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): [number, number] | null => {
    const key = (x: number, y: number) => y * snap.cols + x;
    const prev = new Map<number, number>();
    prev.set(key(fromX, fromY), -1);
    const queue = [key(fromX, fromY)];
    const target = key(toX, toY);
    while (queue.length > 0) {
      const cell = queue.shift()!;
      if (cell === target) {
        // Walk back to the first step.
        let cur = cell;
        for (;;) {
          const p = prev.get(cur)!;
          if (p === key(fromX, fromY)) break;
          if (p === -1) return null; // already at target
          cur = p;
        }
        return [(cur % snap.cols) - fromX, Math.floor(cur / snap.cols) - fromY];
      }
      const cx = cell % snap.cols;
      const cy = Math.floor(cell / snap.cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= snap.cols || ny >= snap.rows) continue;
        const nk = key(nx, ny);
        if (prev.has(nk)) continue;
        if (occupied.has(nk) && nk !== target) continue;
        prev.set(nk, cell);
        queue.push(nk);
      }
    }
    return null;
  };
  const solver = setInterval(() => {
    const snap = latestSnapshot as PuzzleSnapshot | null;
    if (!snap || snap.kind !== 'puzzle' || snap.phase !== 'play') return;
    const bySlot = new Map(snap.pieces.map((p) => [p.id, p] as const));
    // Target origin per group: a group with locked (phantom) pieces must
    // assemble at the phantom's origin; other groups get non-overlapping
    // anchors tiled in 3x3 blocks so bot teams never fight over cells.
    const groupOrigin = new Map<number, [number, number]>();
    for (const p of snap.pieces) {
      if (p.locked && !groupOrigin.has(p.g)) {
        groupOrigin.set(p.g, [p.cx - QUAD_DX[p.q], p.cy - QUAD_DY[p.q]]);
      }
    }
    // Anchor slots on a stride-3 grid, x starting at 1 so no 2x2 area ever
    // contains a board corner — a corner target cell can be permanently
    // walled in by two parked teammates.
    const anchorXs: number[] = [];
    for (let x = 1; x <= snap.cols - 3; x += 3) anchorXs.push(x);
    const anchorYs: number[] = [];
    for (let y = 0; y <= snap.rows - 2; y += 3) anchorYs.push(y);
    for (const p of snap.pieces) {
      if (groupOrigin.has(p.g)) continue;
      const ox = anchorXs[p.g % anchorXs.length];
      const oy = anchorYs[Math.floor(p.g / anchorXs.length) % anchorYs.length];
      groupOrigin.set(p.g, [ox, oy]);
    }
    const occupied = new Set<number>(snap.pieces.map((p) => p.cy * snap.cols + p.cx));
    for (const bot of bots) {
      const piece = bySlot.get(bot.slot);
      if (!piece || piece.locked) continue;
      const [ox, oy] = groupOrigin.get(piece.g)!;
      const tx = ox + QUAD_DX[piece.q];
      const ty = oy + QUAD_DY[piece.q];
      if (tx === piece.cx && ty === piece.cy) {
        bot.socket.emit('input', { t: 'dir', x: 0, y: 0 });
        continue;
      }
      const step = bfsStep(snap, occupied, piece.cx, piece.cy, tx, ty);
      const stepBlocked =
        step && occupied.has((piece.cy + step[1]) * snap.cols + (piece.cx + step[0]));
      if (step && (!stepBlocked || Math.random() > 0.35)) {
        bot.socket.emit('input', { t: 'dir', x: step[0], y: step[1] });
      } else {
        // Boxed in, or waiting on an occupied target (sometimes sidestep so
        // swap/rotation wait-cycles between pieces can't deadlock forever).
        const options: [number, number][] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = piece.cx + dx;
          const ny = piece.cy + dy;
          if (nx < 0 || ny < 0 || nx >= snap.cols || ny >= snap.rows) continue;
          if (!occupied.has(ny * snap.cols + nx)) options.push([dx, dy]);
        }
        const pick = options[Math.floor(Math.random() * options.length)];
        if (pick) bot.socket.emit('input', { t: 'dir', x: pick[0], y: pick[1] });
      }
    }
  }, 120);

  const donePuzzle = await waitFor('all puzzle groups to lock', 60000, () => {
    const snap = latestSnapshot as PuzzleSnapshot | null;
    return snap?.kind === 'puzzle' && snap.phase === 'over' ? snap : null;
  });
  clearInterval(solver);
  await sleep(300); // let the final me/teamRank events land
  // Every locked group must form an exact 2x2 with one piece per quadrant.
  for (let g = 0; g < donePuzzle.groupCount; g++) {
    const members = donePuzzle.pieces.filter((p) => p.g === g);
    if (members.length !== 4) fail(`group ${g} has ${members.length} pieces`);
    const origins = new Set(
      members.map((p) => `${p.cx - QUAD_DX[p.q]},${p.cy - QUAD_DY[p.q]}`),
    );
    const quads = new Set(members.map((p) => p.q));
    if (origins.size !== 1 || quads.size !== 4) {
      fail(
        `group ${g} locked without forming a 2x2: ${members
          .map((p) => `q${p.q}@(${p.cx},${p.cy})`)
          .join(' ')}`,
      );
    }
  }
  if (donePuzzle.finished.length !== donePuzzle.groupCount) {
    fail('puzzle over but finished list incomplete');
  }
  const rankedBot = bots.find((b) => b.me?.teamRank !== undefined);
  if (!rankedBot) fail('no bot received a teamRank');
  console.log(`puzzle: all ${donePuzzle.groupCount} groups locked, order [${donePuzzle.finished}]`);

  // Back to lobby.
  stage.emit('host:lobby');
  await waitFor('players back in lobby', 5000, () =>
    bots.every((b) => b.me?.phase === 'lobby') ? true : null,
  );
  console.log('back to lobby OK');

  // ==========================================================================
  // Fake players (server-driven bots)
  // ==========================================================================
  stage.emit('host:bots', { delta: 8 });
  const roomWithBots = await waitFor('8 fake players to join', 3000, () =>
    latestRoom && latestRoom.players.length === NUM_PLAYERS + 8 ? latestRoom : null,
  );
  const fakeSlots = roomWithBots.players.filter((p) => p.bot).map((p) => p.id);
  if (fakeSlots.length !== 8) fail(`expected 8 bot-flagged players, got ${fakeSlots.length}`);

  // Fake players must move by themselves in Last One Standing.
  stage.emit('host:start', { game: 'los' });
  await waitFor('bot LOS play phase', 8000, () =>
    latestSnapshot?.kind === 'los' && latestSnapshot.phase === 'play' ? true : null,
  );
  const beforeBots = new Map<number, [number, number]>();
  for (const [slot, x, y] of (latestSnapshot as unknown as LosSnapshot).players) {
    if (fakeSlots.includes(slot)) beforeBots.set(slot, [x, y]);
  }
  await sleep(2000);
  {
    const snap = latestSnapshot as unknown as LosSnapshot;
    let moved = 0;
    for (const [slot, x, y] of snap.players) {
      const before = beforeBots.get(slot);
      if (before && Math.hypot(x - before[0], y - before[1]) > 20) moved++;
    }
    if (moved < 6) fail(`fake players not moving on their own (moved=${moved}/8)`);
    console.log(`bots: ${moved}/8 fake players moving autonomously in LOS`);
  }
  stage.emit('host:lobby');
  await sleep(300);
  stage.emit('host:bots', { delta: -8 });
  await waitFor('fake players removed', 3000, () =>
    latestRoom && latestRoom.players.length === NUM_PLAYERS ? true : null,
  );
  console.log('bots: add/remove OK');

  // A room of ONLY fake players must solve Team Puzzles by itself.
  const stage2 = connect();
  let room2: RoomState | null = null;
  let snap2: StageSnapshot | null = null;
  stage2.on('room', (r: RoomState) => {
    room2 = r;
  });
  stage2.on('snapshot', (s: StageSnapshot) => {
    snap2 = s;
  });
  await new Promise<void>((resolve) => {
    stage2.emit('stage:create', () => resolve());
  });
  stage2.emit('host:bots', { delta: 8 });
  await waitFor('bots in second room', 3000, () =>
    room2 && (room2 as RoomState).players.length === 8 ? true : null,
  );
  stage2.emit('host:start', { game: 'puzzle', options: { rotation: false } });
  const botPuzzle = await waitFor('bots to solve the puzzle unaided', 60000, () => {
    const s = snap2 as PuzzleSnapshot | null;
    return s?.kind === 'puzzle' && s.phase === 'over' ? s : null;
  });
  if (botPuzzle.finished.length !== botPuzzle.groupCount) {
    fail('bot-only puzzle ended without all groups locked');
  }
  console.log(`bots: solved a bots-only puzzle (${botPuzzle.groupCount} groups)`);

  console.log('\nSMOKE PASS ✅');
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
