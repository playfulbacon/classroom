// End-to-end smoke test: spins up the real server, connects a stage plus a
// classroom of simulated phones over real sockets, and plays both games.
//   - Last One Standing: bots joystick outward until everyone falls off and
//     the round produces placements.
//   - Team Puzzles: bots read the stage snapshot and steer their pieces into
//     their group's 2x2 arrangement until every group locks.
// Run with: npm run smoke

import { spawn, type ChildProcess } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import {
  NPC_WAITING,
  TETRIS_ALIVE,
  TETRIS_OUT,
  type JoinResponse,
  type LosSnapshot,
  type MedusaPulseMsg,
  type MedusaSnapshot,
  type MeState,
  type PuzzleSnapshot,
  type RoomState,
  type StageSnapshot,
  type TetrisPulseMsg,
  type TetrisSnapshot,
} from '../../shared/protocol';
import { TETRIS_ISO_DIR, groundToScreenDir } from '../../shared/iso';

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

  // Bots steer toward per-group gw x gh anchors using BFS around occupied
  // cells (greedy straight-line seeking deadlocks against parked pieces; a
  // student looking at the board would just steer around them).
  const pqx = (q: number, gw: number) => q % gw;
  const pqy = (q: number, gw: number) => Math.floor(q / gw);
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
    // anchors tiled so bot teams never fight over cells.
    const groupOrigin = new Map<number, [number, number]>();
    for (const p of snap.pieces) {
      if (p.locked && !groupOrigin.has(p.g)) {
        groupOrigin.set(p.g, [p.cx - pqx(p.q, snap.gw), p.cy - pqy(p.q, snap.gw)]);
      }
    }
    // Anchor slots on a stride grid, x starting at 1 so no area ever
    // contains a board corner — a corner target cell can be permanently
    // walled in by parked teammates.
    const anchorXs: number[] = [];
    for (let x = 1; x <= snap.cols - snap.gw - 1; x += snap.gw + 1) anchorXs.push(x);
    const anchorYs: number[] = [];
    for (let y = 0; y <= snap.rows - snap.gh; y += snap.gh + 1) anchorYs.push(y);
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
      const tx = ox + pqx(piece.q, snap.gw);
      const ty = oy + pqy(piece.q, snap.gw);
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

  const dumpBoard = (label: string) => {
    const snap = latestSnapshot as PuzzleSnapshot | null;
    if (!snap || snap.kind !== 'puzzle') return;
    const board: string[][] = Array.from({ length: snap.rows }, () =>
      Array(snap.cols).fill(' . '),
    );
    for (const p of snap.pieces) {
      board[p.cy][p.cx] = `${p.g}${String.fromCharCode(97 + p.q)}${p.locked ? '*' : ' '}`;
    }
    console.log(`[${label}] finished=[${snap.finished}]`);
    console.log(board.map((r) => r.join(' ')).join('\n'));
  };
  const donePuzzle = await (async () => {
    const start = Date.now();
    for (;;) {
      const snap = latestSnapshot as PuzzleSnapshot | null;
      if (snap?.kind === 'puzzle' && snap.phase === 'over') return snap;
      if (Date.now() - start > 60000) {
        dumpBoard('stuck');
        fail('timed out waiting for all puzzle groups to lock');
      }
      await sleep(50);
    }
  })();
  clearInterval(solver);
  await sleep(300); // let the final me/teamRank events land
  // Every locked group must form an exact gw x gh with one piece per position.
  const assertGeometry = (snap: PuzzleSnapshot, label: string) => {
    const K = snap.gw * snap.gh;
    for (let g = 0; g < snap.groupCount; g++) {
      const members = snap.pieces.filter((p) => p.g === g);
      if (members.length !== K) fail(`${label}: group ${g} has ${members.length} pieces`);
      const origins = new Set(
        members.map((p) => `${p.cx - pqx(p.q, snap.gw)},${p.cy - pqy(p.q, snap.gw)}`),
      );
      const quads = new Set(members.map((p) => p.q));
      if (origins.size !== 1 || quads.size !== K) {
        fail(
          `${label}: group ${g} locked without forming ${snap.gw}x${snap.gh}: ${members
            .map((p) => `q${p.q}@(${p.cx},${p.cy})`)
            .join(' ')}`,
        );
      }
    }
  };
  assertGeometry(donePuzzle, '2x2');
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

  // ==========================================================================
  // Puzzle pictures (upload / serve / assign / remove)
  // ==========================================================================
  const fakeJpeg = (tag: string) => Buffer.from(`fake-jpeg-bytes-${tag}`).toString('base64');
  {
    const res = await new Promise<{ ok: boolean }>((resolve) => {
      bots[0].socket.emit('host:art:add', { data: fakeJpeg('sneaky') }, resolve);
    });
    if (res.ok) fail('a non-stage socket was allowed to upload art');
  }
  const artIds: string[] = [];
  for (const tag of ['one', 'two']) {
    const res = await new Promise<{ ok: boolean; id?: string; err?: string }>((resolve) => {
      stage.emit('host:art:add', { data: fakeJpeg(tag) }, resolve);
    });
    if (!res.ok || !res.id) fail(`art upload failed: ${res.err}`);
    artIds.push(res.id);
  }
  await waitFor('room state to list images', 3000, () =>
    latestRoom && latestRoom.images.length === 2 ? true : null,
  );
  {
    const httpRes = await fetch(`${BASE_URL}/art/${code}/${artIds[0]}`);
    if (!httpRes.ok) fail(`GET /art returned ${httpRes.status}`);
    const body = Buffer.from(await httpRes.arrayBuffer());
    if (!body.equals(Buffer.from('fake-jpeg-bytes-one'))) fail('served art bytes differ');
    const miss = await fetch(`${BASE_URL}/art/${code}/nope`);
    if (miss.status !== 404) fail('missing art should 404');
  }
  stage.emit('host:start', { game: 'puzzle' });
  const imgPuzzle = await waitFor('puzzle with images', 5000, () =>
    latestSnapshot?.kind === 'puzzle' ? (latestSnapshot as PuzzleSnapshot) : null,
  );
  if (imgPuzzle.groupImages[0] !== artIds[0] || imgPuzzle.groupImages[1] !== artIds[1]) {
    fail(`first groups did not get the uploaded images: ${imgPuzzle.groupImages}`);
  }
  if (imgPuzzle.groupCount > 2 && imgPuzzle.groupImages[2] !== null) {
    fail('extra groups should fall back to procedural art (null)');
  }
  {
    const inG0 = bots.find((b) => b.me?.game === 'puzzle' && b.me.group === 0);
    if (!inG0) fail('no player found in group 0');
    if (inG0.me?.imageId !== artIds[0]) {
      fail(`group-0 phone got imageId ${inG0.me?.imageId}, expected ${artIds[0]}`);
    }
  }
  stage.emit('host:lobby');
  await sleep(300);
  for (const id of artIds) stage.emit('host:art:remove', { id });
  await waitFor('images removed', 3000, () =>
    latestRoom && latestRoom.images.length === 0 ? true : null,
  );
  console.log('art: upload/serve/assign/remove OK');

  // ==========================================================================
  // Game 3: Medusa
  // ==========================================================================
  // Eye mode is ON for the round, but per-player: only phones streaming eye
  // reports get eye rules — everyone else (victim, faller, safe runners)
  // exercises the classic path in the same round.
  // Phone-channel contract: players get a personal 'pulse' stream through
  // the round — but NEVER stage snapshots.
  let pulseMsgs = 0;
  let lastPulse: MedusaPulseMsg | null = null;
  bots[2].socket.on('pulse', (m: MedusaPulseMsg) => {
    pulseMsgs++;
    lastPulse = m;
  });
  bots[2].socket.on('snapshot', () => fail('a phone received a stage snapshot'));
  stage.emit('host:start', { game: 'medusa', options: { medusaEyes: true } });
  // The narrated intro waits for the stage; this headless stage skips it.
  await waitFor('medusa play phase', 12000, () => {
    if (latestSnapshot?.kind !== 'medusa') return null;
    if (latestSnapshot.phase === 'intro') {
      stage.emit('host:intro-done');
      return null;
    }
    return latestSnapshot.phase === 'play' ? true : null;
  });
  const med0 = latestSnapshot as unknown as MedusaSnapshot;
  console.log(
    `medusa: field ${med0.length}x${med0.lanes} — ${med0.pits.length} pit cells, ` +
      `${med0.platforms.length} ferries, ${med0.crumble.length} crumble cells`,
  );
  if (med0.platforms.length < 2) fail('expected ferry platforms on the field');
  const pitSet = new Set(med0.pits.map(([c, l]) => l * 1000 + c));
  const isPit = (c: number, l: number) => pitSet.has(l * 1000 + c);
  const crumbleSet = new Set(med0.crumble.map(([c, l]) => l * 1000 + c));
  const routes = med0.platforms.map(([id, lane, c0, c1]) => ({ id, lane, c0, c1 }));
  const onFerryRoute = (c: number, l: number) =>
    routes.some((p) => p.lane === l && c >= p.c0 && c <= p.c1);
  // The driver avoids crumble entirely (like the server bots) and treats
  // pit cells off ferry routes as walls.
  const blockedCell = (c: number, l: number) =>
    (isPit(c, l) && !onFerryRoute(c, l)) || crumbleSet.has(l * 1000 + c);
  // Tighter than the server's ALIGN_EPS (0.35): the snapshot pos is rounded
  // and up to a tick stale, and a boarding hop judged aligned here must
  // still be aligned server-side — open water drowns now.
  const ferryAligned = (s: MedusaSnapshot, c: number, l: number) =>
    s.platforms.some(
      ([, lane, c0, c1, pos]) => lane === l && c >= c0 && c <= c1 && Math.abs(pos - c) <= 0.15,
    );
  const noCamera = bots[0].slot; // never reports — the slow death must find them
  const pitBumper = bots[1].slot; // deliberately hops into a pit — must fall in and die
  const closedRunner = bots[2].slot; // streams eyes-closed, never stops hopping
  const openStarer = bots[3].slot; // streams eyes-open, stands still → tiers → stone
  let bumpAttempts = 0;
  let starerTierSeen = 0;
  let noCameraMeterSeen = 0;

  let driverTick = 0;
  const medusaDriver = setInterval(() => {
    driverTick++;
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa' || s.phase !== 'play') return;
    const pos = new Map(s.players.map((p) => [p[0], p] as const));
    const green = s.gaze.state === 'green';
    // BFS to the finish column around obstacles; returns null to wait for a
    // ferry (boarding hops are only sent when the ferry is actually there).
    const dodge = (col: number, lane: number): 'f' | 'l' | 'r' | 'b' | null => {
      const key = (c: number, l: number) => l * 1000 + c;
      const prev = new Map<number, number>();
      const queue = [key(col, lane)];
      prev.set(queue[0], -1);
      let goal = -1;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const c = cur % 1000;
        const l = Math.floor(cur / 1000);
        if (c === s.length - 1) {
          goal = cur;
          break;
        }
        for (const [dc, dl] of [[1, 0], [0, -1], [0, 1], [-1, 0]] as const) {
          const nc = c + dc;
          const nl = l + dl;
          if (nc < 0 || nc >= s.length || nl < 0 || nl >= s.lanes) continue;
          const nk = key(nc, nl);
          if (prev.has(nk) || blockedCell(nc, nl)) continue;
          prev.set(nk, cur);
          queue.push(nk);
        }
      }
      if (goal < 0) return null; // walled in (cannot happen)
      let step = goal;
      while (prev.get(step) !== key(col, lane) && prev.get(step) !== -1) {
        step = prev.get(step)!;
      }
      if (prev.get(step) === -1) return 'f'; // already at the goal cell
      const sc = step % 1000;
      const sl = Math.floor(step / 1000);
      if (isPit(sc, sl) && !ferryAligned(s, sc, sl)) return null; // wait at the bank
      const dc = sc - col;
      const dl = sl - lane;
      return dc === 1 ? 'f' : dc === -1 ? 'b' : dl === -1 ? 'l' : 'r';
    };
    const hop = (bot: (typeof bots)[number], d: 'f' | 'l' | 'r' | 'b' | null) => {
      if (d) bot.socket.emit('input', { t: 'hop', d });
    };
    // Track meter/tier evidence for the assertions below.
    {
      const starer = pos.get(openStarer);
      if (starer) starerTierSeen = Math.max(starerTierSeen, starer[6]);
      const nc = pos.get(noCamera);
      if (nc) noCameraMeterSeen = Math.max(noCameraMeterSeen, nc[5]);
    }
    for (const bot of bots) {
      const p = pos.get(bot.slot);
      if (!p || p[3] !== 0) continue;
      const [, col, lane] = p;
      // Mid-ferry: step off only onto something that can actually be landed
      // on — solid bank, or (rarely) another docked ferry. Hopping forward
      // mid-crossing is open water and open water drowns now.
      const riding = isPit(col, lane);
      const landable = (c: number, l: number) =>
        !blockedCell(c, l) && (!isPit(c, l) || ferryAligned(s, c, l));
      const advance = () =>
        hop(bot, riding ? (landable(col + 1, lane) ? 'f' : null) : dodge(col, lane));
      if (bot.slot === noCamera) {
        // Never streams gaze; only ever moves on green, and camps mid-field
        // (so it can never outrun the meter to the finish). The slow death
        // must find them during red.
        if (green && driverTick % 3 === 0 && col < 12) advance();
        continue;
      }
      if (bot.slot === openStarer) {
        // Streams eyes-OPEN and never moves: tiers must climb and the meter
        // must fill to a statue — movement was never the crime.
        bot.socket.emit('input', { t: 'gaze', s: 2, c: 0.9 });
        continue;
      }
      // Everyone else (closedRunner included) plays eyes-closed and sprints
      // straight through red — movement is never the crime in v2.
      bot.socket.emit('input', { t: 'gaze', s: 1, c: 0.9 });
      if (bot.slot !== pitBumper) {
        advance();
        continue;
      }
      if (!green) continue;
      {
        // Steers at the nearest true pit and hops straight into it. Pits
        // are always deadly now — the first hop in must swallow the diver.
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (const [c, l] of med0.pits) {
          if (c < col || onFerryRoute(c, l)) continue;
          const d = c - col + Math.abs(l - lane);
          if (d < bestD) {
            bestD = d;
            best = [c, l];
          }
        }
        if (!best) continue;
        const d = best[1] !== lane ? (best[1] < lane ? 'l' : 'r') : 'f';
        const tc = d === 'f' ? col + 1 : col;
        const tl = d === 'l' ? lane - 1 : d === 'r' ? lane + 1 : lane;
        if (isPit(tc, tl)) bumpAttempts++;
        hop(bot, d);
      }
    }
  }, 130);

  await waitFor('runners to make progress', 30000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    return s.players.some((p) => p[1] >= 5) ? true : null;
  });
  // Snapshot gaze flags: 3 (unknown) for the camera-less, 1 (closed) for the
  // blind sprinter.
  {
    const s = latestSnapshot as unknown as MedusaSnapshot;
    if (!s.eyesMode) fail('snapshot must flag eyesMode for a v2 round');
    const gzOf = (slot: number) => s.players.find((p) => p[0] === slot)?.[4];
    if (gzOf(noCamera) !== 3) fail(`noCamera gz flag ${gzOf(noCamera)}, expected 3`);
    if (gzOf(closedRunner) !== 1) {
      fail(`closed runner gz flag ${gzOf(closedRunner)}, expected 1`);
    }
  }
  await waitFor('the open-eyed starer to tier up and petrify standing still', 45000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    const p = s.players.find((q) => q[0] === openStarer);
    return p && p[3] === 1 ? true : null;
  });
  if (starerTierSeen < 1) {
    fail(`open starer petrified without ever reaching tier 1 (saw ${starerTierSeen})`);
  }
  // By now at least one red has passed: verify the phone channel.
  {
    if (pulseMsgs < 10) fail(`only ${pulseMsgs} pulse messages reached the phone`);
    const pu = lastPulse as MedusaPulseMsg | null;
    if (!pu || pu.me.length !== 5 || pu.g.length !== 2) fail('pulse message malformed');
    else if (pu.me[4] !== 1) fail(`closed runner pulse eyes ${pu.me[4]}, expected 1 (closed)`);
    console.log(`medusa: phone channel — ${pulseMsgs} pulses, no snapshots`);
  }
  await waitFor('the closed-eyes runner to finish alive', 60000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    const p = s.players.find((q) => q[0] === closedRunner);
    if (p && p[3] === 1) fail('closed runner died — eyes-closed red sprints must be legal');
    return p && p[3] === 2 ? true : null;
  });
  console.log(
    `medusa: eyes-only — open starer tiered (max ${starerTierSeen}) then petrified; blind sprinter escaped`,
  );
  const statueBot = await waitFor('the camera-less player to die the slow death', 90000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    const p = s.players.find((q) => q[0] === noCamera);
    return p && p[3] === 1 ? bots[0] : null;
  });
  if (noCameraMeterSeen <= 0) fail('noCamera meter never rose — slow death not observed');
  await waitFor("the statue's phone to learn its fate", 5000, () =>
    statueBot.me?.medusaState === 'stone' ? true : null,
  );
  console.log(
    `medusa: hiding from the camera was a slow death (meter peaked ${noCameraMeterSeen})`,
  );
  await waitFor('the pit diver to fall in and die', 45000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    const p = s.players.find((q) => q[0] === pitBumper);
    return p && p[3] === 3 ? true : null;
  });
  {
    const s = latestSnapshot as unknown as MedusaSnapshot;
    const p = s.players.find((q) => q[0] === pitBumper)!;
    if (!isPit(p[1], p[2])) fail('the fallen diver should be IN the pit cell');
  }
  await waitFor("the diver's phone to learn its fate", 5000, () =>
    bots[1].me?.medusaState === 'fallen' ? true : null,
  );
  console.log(
    `medusa: pits are deadly — the diver fell on attempt ${bumpAttempts} and the phone knows`,
  );
  const medDone = await waitFor('most runners to finish', 95000, () => {
    const s = latestSnapshot as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa') return null;
    return s.finished.length >= 6 || s.phase === 'over' ? s : null;
  });
  clearInterval(medusaDriver);
  if (medDone.finished.length < 6) {
    fail(`only ${medDone.finished.length} finished a runnable field`);
  }
  if (new Set(medDone.finished).size !== medDone.finished.length) {
    fail('medusa placements contain duplicates');
  }
  if (medDone.players.some((p) => p[3] > 3)) {
    fail('a player left running/stone/finished/fallen — nothing else exists now');
  }
  const winner = bots.find((b) => b.slot === medDone.finished[0]);
  if (winner && winner.me?.placement !== 1) {
    await sleep(400);
    if (winner.me?.placement !== 1) fail('winner phone did not get placement 1');
  }
  console.log(
    `medusa: ${medDone.finished.length} escaped, statue + pit-fall confirmed, winner slot ${medDone.finished[0]}`,
  );
  stage.emit('host:lobby');
  await waitFor('lobby after medusa', 5000, () =>
    bots.every((b) => b.me?.phase === 'lobby') ? true : null,
  );

  // ==========================================================================
  // Game 4: Human Tetris
  // ==========================================================================
  // Socket players steer (screen-space joysticks, like thumbs) into the
  // shape; one hides in a corner and must be flattened; one plays hero and
  // must carry an NPC to safety. Phones get the personal SAFE/OUTSIDE pulse.
  let tzPulses = 0;
  let tzInsideSeen = false;
  let tzCarrySeen = false;
  let tzPlaced = 0;
  bots[2].socket.on('pulse', (m: TetrisPulseMsg) => {
    if (!Array.isArray(m)) return;
    tzPulses++;
    if (m[0] === 1 && m[2] === 0) tzInsideSeen = true;
  });
  stage.emit('host:start', { game: 'tetris' });
  await waitFor('tetris play phase', 8000, () =>
    latestSnapshot?.kind === 'tetris' && latestSnapshot.phase === 'play' ? true : null,
  );
  const tz0 = latestSnapshot as unknown as TetrisSnapshot;
  console.log(
    `tetris: field ${tz0.fieldW}x${tz0.fieldD}, budget ${tz0.lossBudget}, round 1 timer ${tz0.timeLimit}s, ` +
      `shape ${tz0.shape?.w}x${tz0.shape?.h} at (${tz0.shape?.x0},${tz0.shape?.z0})`,
  );
  if (!tz0.shape) fail('round 1 has no shape');
  const cornerHider = bots[0].slot; // walks to the corner: flattened in round 1
  const hero = bots[1].slot; // fetches the first NPC it sees
  const timers = new Map<number, number>();
  const joyToward = (b: Bot, x: number, z: number, tx: number, tz: number) => {
    const dx = tx - x;
    const dz = tz - z;
    if (Math.hypot(dx, dz) < 0.1) {
      b.socket.emit('input', { t: 'joy', x: 0, y: 0 });
      return;
    }
    const s = groundToScreenDir(TETRIS_ISO_DIR, dx, dz);
    b.socket.emit('input', { t: 'joy', x: s.x, y: s.y });
  };
  const tetrisDriver = setInterval(() => {
    const s = latestSnapshot as TetrisSnapshot | null;
    if (!s || s.kind !== 'tetris' || s.phase !== 'play' || !s.shape) return;
    timers.set(s.round, s.timeLimit);
    const cells: [number, number][] = [];
    for (let r = 0; r < s.shape.h; r++) {
      for (let c = 0; c < s.shape.w; c++) {
        if (s.shape.rows[r][c] === '1') cells.push([s.shape.x0 + c + 0.5, s.shape.z0 + r + 0.5]);
      }
    }
    const pos = new Map(s.players.map((p) => [p[0], p] as const));
    bots.forEach((b, i) => {
      const p = pos.get(b.slot);
      if (!p || p[3] !== TETRIS_ALIVE) return;
      const [, x, z, , carrying] = p;
      if (b.slot === cornerHider) {
        joyToward(b, x, z, 0.5, 0.5);
        return;
      }
      const inShape = (px: number, pz: number) => {
        const c = Math.floor(px) - s.shape!.x0;
        const r = Math.floor(pz) - s.shape!.z0;
        return c >= 0 && r >= 0 && c < s.shape!.w && r < s.shape!.h && s.shape!.rows[r][c] === '1';
      };
      if (b.slot === hero) {
        // Fetch stranded NPCs (outside the shape); once inside with one on
        // the shoulders, tap to set it down and go back for the next.
        if (!carrying) {
          const npc = s.npcs.find((n) => n[3] === NPC_WAITING && !inShape(n[1], n[2]));
          if (npc) {
            joyToward(b, x, z, npc[1], npc[2]);
            return;
          }
        } else if (inShape(x, z)) {
          tzPlaced++;
          b.socket.emit('input', { t: 'place' });
        }
      }
      if (carrying) tzCarrySeen = true;
      // Spread the crowd over the shape by slot.
      const [tx, tzz] = cells[i % cells.length];
      joyToward(b, x, z, tx, tzz);
    });
  }, 120);
  await waitFor('the phone pulse to report INSIDE during a round', 20000, () =>
    tzInsideSeen ? true : null,
  );
  const tzRound1 = await waitFor('round 1 to drop', 25000, () => {
    const s = latestSnapshot as TetrisSnapshot | null;
    return s?.kind === 'tetris' && s.round === 1 && s.roundPhase !== 'form' ? s : null;
  });
  {
    const hider = tzRound1.players.find((p) => p[0] === cornerHider);
    if (!hider || hider[3] !== TETRIS_OUT) fail('the corner hider was not flattened');
    if (!tzRound1.lastCrushed[0].includes(cornerHider)) fail('lastCrushed misses the hider');
    const inside = tzRound1.players.filter((p) => p[3] === TETRIS_ALIVE).length;
    if (inside < NUM_PLAYERS - 3) fail(`only ${inside} players made it inside in round 1`);
    console.log(`tetris: round 1 — ${inside} inside, hider #${cornerHider} flattened`);
  }
  await waitFor("the hider's phone to learn its fate", 5000, () =>
    bots[0].me?.tetrisState === 'out' ? true : null,
  );
  await waitFor('round 1 to clear and round 2 to start', 15000, () => {
    const s = latestSnapshot as TetrisSnapshot | null;
    return s?.kind === 'tetris' && s.round >= 2 && s.cleared >= 1 ? true : null;
  });
  {
    const s = latestSnapshot as unknown as TetrisSnapshot;
    if (s.npcs.length < 1) fail('no NPC appeared in round 2');
    if (s.timeLimit >= tz0.timeLimit) fail('the timer did not shorten');
    if (tzPulses < 10) fail(`only ${tzPulses} tetris pulses reached the phone`);
  }
  await waitFor('the hero to rescue an NPC', 60000, () => {
    const s = latestSnapshot as TetrisSnapshot | null;
    if (!s || s.kind !== 'tetris') return null;
    if (s.phase === 'over') fail(`the crowd lost before any rescue (cleared ${s.cleared})`);
    return s.rescued >= 1 ? true : null;
  });
  if (!tzCarrySeen) fail('the hero never showed as carrying');
  if (tzPlaced === 0) fail('the hero never set an NPC down');
  await waitFor("the hero's phone to know it carried", 3000, () =>
    bots[1].me?.game === 'tetris' ? true : null,
  );
  clearInterval(tetrisDriver);
  {
    const s = latestSnapshot as unknown as TetrisSnapshot;
    console.log(
      `tetris: ${s.cleared} rounds cleared, ${s.rescued} rescued, ${s.losses}/${s.lossBudget} losses, timers ${[...timers.values()].join('→')}`,
    );
  }
  stage.emit('host:lobby');
  await waitFor('lobby after tetris', 5000, () =>
    bots.every((b) => b.me?.phase === 'lobby') ? true : null,
  );

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
  // 8 bots on a 3x2 puzzle: two teams of 4 players + 2 phantoms each — the
  // uneven-team path with a non-square puzzle, solved fully unaided.
  stage2.emit('host:start', {
    game: 'puzzle',
    options: { rotation: false, puzzleW: 3, puzzleH: 2 },
  });
  const botPuzzle = await waitFor('bots to solve the 3x2 puzzle unaided', 90000, () => {
    const s = snap2 as PuzzleSnapshot | null;
    return s?.kind === 'puzzle' && s.phase === 'over' ? s : null;
  });
  if (botPuzzle.gw !== 3 || botPuzzle.gh !== 2) {
    fail(`expected a 3x2 puzzle, got ${botPuzzle.gw}x${botPuzzle.gh}`);
  }
  if (botPuzzle.groupCount !== 2) fail(`expected 2 groups, got ${botPuzzle.groupCount}`);
  const phantomCount = botPuzzle.pieces.filter((p) => p.id < 0).length;
  if (phantomCount !== 4) fail(`expected 4 phantom pieces, got ${phantomCount}`);
  if (botPuzzle.finished.length !== botPuzzle.groupCount) {
    fail('bot-only puzzle ended without all groups locked');
  }
  assertGeometry(botPuzzle, '3x2 bots');
  console.log(`bots: solved a bots-only 3x2 puzzle (${botPuzzle.groupCount} groups, 4 phantoms)`);

  // The same bots-only room must run a full CLASSIC Medusa round unaided
  // (eye mode is the default now, so opt out explicitly): bots sprint on
  // green, freeze on red (mostly), and at least someone escapes.
  stage2.emit('host:start', { game: 'medusa', options: { medusaEyes: false } });
  const botMedusa = await waitFor('bots-only medusa round to end', 110000, () => {
    const cur = latestSnapshot as MedusaSnapshot | null;
    if (cur?.kind === 'medusa' && cur.phase === 'intro') stage2.emit('host:intro-done');
    const s = snap2 as MedusaSnapshot | null;
    return s?.kind === 'medusa' && s.phase === 'over' ? s : null;
  });
  if (botMedusa.finished.length < 1) fail('no bot escaped Medusa in a full round');
  const botStones = botMedusa.players.filter((p) => p[3] === 1).length;
  console.log(
    `bots: medusa round complete — ${botMedusa.finished.length} escaped, ${botStones} statues`,
  );
  // Medusa is a self-restarting series now — stop it so the room doesn't
  // keep simulating rounds in the background for the rest of the run.
  stage2.emit('host:lobby');

  // ...and hold a Human Tetris crowd together unaided: the fake players
  // must clear at least two rounds before the wall wins.
  stage2.emit('host:start', { game: 'tetris' });
  const botTetris = await waitFor('bots-only tetris to clear two rounds', 80000, () => {
    const s = snap2 as TetrisSnapshot | null;
    if (!s || s.kind !== 'tetris') return null;
    if (s.phase === 'over' && s.cleared < 2) fail(`bots lost tetris after ${s.cleared} rounds`);
    return s.cleared >= 2 ? s : null;
  });
  console.log(
    `bots: tetris — cleared ${botTetris.cleared} rounds, ${botTetris.rescued} rescued, ` +
      `${botTetris.losses}/${botTetris.lossBudget} lost`,
  );

  // ==========================================================================
  // Idle-human regression: bots must not freeze against a player who never
  // moves (the reported stuck-bot bug).
  // ==========================================================================
  const stage3 = connect();
  let room3: RoomState | null = null;
  let snap3: StageSnapshot | null = null;
  stage3.on('room', (r: RoomState) => {
    room3 = r;
  });
  stage3.on('snapshot', (s: StageSnapshot) => {
    snap3 = s;
  });
  const code3 = await new Promise<string>((resolve) => {
    stage3.emit('stage:create', (res: { code: string }) => resolve(res.code));
  });
  const idle = connect();
  const idleJoin = await new Promise<JoinResponse>((resolve) => {
    idle.emit('join', { code: code3, name: 'Idle' }, resolve);
  });
  if (!idleJoin.ok || !idleJoin.playerId) fail('idle player failed to join');
  stage3.emit('host:bots', { delta: 7 });
  await waitFor('bots in third room', 3000, () =>
    room3 && (room3 as RoomState).players.length === 8 ? true : null,
  );
  stage3.emit('host:start', { game: 'puzzle', options: { puzzleW: 2, puzzleH: 2 } });
  const idleSlot = idleJoin.playerId;
  // The all-bot team must finish even though the idle player's piece sits
  // parked somewhere on the board the whole round.
  const withIdle = await waitFor('all-bot team to finish despite idle player', 60000, () => {
    const s = snap3 as PuzzleSnapshot | null;
    if (!s || s.kind !== 'puzzle') return null;
    const idlePiece = s.pieces.find((p) => p.id === idleSlot);
    if (!idlePiece) return null;
    const done = s.finished.some((g) => g !== idlePiece.g);
    return done ? s : null;
  });
  {
    const idlePiece = withIdle.pieces.find((p) => p.id === idleSlot)!;
    // The idle player's bot teammates stay live: under the one-runner-at-a-
    // time scheme most of them deliberately wait far from the area, so the
    // meaningful property is that none of them ends up PERSISTENTLY entombed
    // (an unlocked piece with zero free neighbours, stuck in the same spot
    // across several seconds, was exactly the reported freeze). A moment of
    // being boxed in by movable neighbours is fine — they walk away.
    let entombedStreak = new Map<number, number>();
    for (let sample = 0; sample < 5; sample++) {
      await sleep(1200);
      const s = snap3 as PuzzleSnapshot | null;
      if (!s || s.kind !== 'puzzle') fail('lost puzzle snapshot in idle room');
      const occupied = new Set(s!.pieces.map((p) => p.cy * s!.cols + p.cx));
      const next = new Map<number, number>();
      for (const p of s!.pieces.filter((p2) => p2.g === idlePiece.g && p2.id !== idleSlot)) {
        if (p.locked) continue;
        let exits = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = p.cx + dx;
          const ny = p.cy + dy;
          if (nx < 0 || ny < 0 || nx >= s!.cols || ny >= s!.rows) continue;
          if (!occupied.has(ny * s!.cols + nx)) exits++;
        }
        if (exits === 0) {
          const pos = p.cy * s!.cols + p.cx;
          const streak = (entombedStreak.get(p.id) === pos ? 1 : 0) + 1;
          if (streak >= 2 && sample === 4) {
            fail(`idle group bot at (${p.cx},${p.cy}) is persistently entombed`);
          }
          next.set(p.id, pos);
        }
      }
      entombedStreak = next;
    }
  }
  console.log('bots: no freeze against an idle human, teammates settle around them');

  console.log('\nSMOKE PASS ✅');
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
