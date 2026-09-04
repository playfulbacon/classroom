// Visual check: boots the production server (serving client/dist), opens the
// stage in headless Chromium, joins bot players over sockets, and captures
// screenshots of the lobby and both games mid-play.
// Run after `npm run build`:  npm run screenshot [-- outDir]
//
// Uses `playwright-core`, which ships no browsers (so `npm install` stays
// fast). The browser is found in this order:
//   1. $CHROMIUM_PATH          explicit executable
//   2. /opt/pw-browsers/chromium   the pre-installed build in CCR containers
//   3. the Chrome / Edge already installed on this machine

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { io, type Socket } from 'socket.io-client';
import type { PuzzleSnapshot, StageSnapshot } from '../../shared/protocol';

const PORT = 4200;
const BASE = `http://localhost:${PORT}`;
const NUM_PLAYERS = 16;
const OUT_DIR = process.argv[2] ?? 'screenshots';

let serverProc: ChildProcess | null = null;
const sockets: Socket[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchBrowser(): Promise<Browser> {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit });

  const containerChromium = '/opt/pw-browsers/chromium';
  if (existsSync(containerChromium)) {
    return chromium.launch({ executablePath: containerChromium });
  }

  const errors: string[] = [];
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ channel });
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    'No browser found. Install Google Chrome or Microsoft Edge, or set ' +
      'CHROMIUM_PATH to a Chromium executable.\n' +
      errors.map((e) => `  ${e}`).join('\n'),
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  serverProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true, // own process group so we can kill npx + tsx together
  });
  await new Promise<void>((resolve) => {
    serverProc!.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) resolve();
    });
  });
  console.log('server up');

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${BASE}/stage`);
  const code = (await page.locator('.lobby-code-block .code').textContent({ timeout: 10000 }))!.trim();
  console.log(`room ${code}`);

  // Bots join.
  const bots: { socket: Socket; slot: number }[] = [];
  let latest: StageSnapshot | null = null;
  const names = [
    'Maya', 'Leo', 'Ava', 'Sam', 'Zoe', 'Kai', 'Mia', 'Eli',
    'Ivy', 'Max', 'Amara', 'Theo', 'Nina', 'Omar', 'Lily', 'Jude',
  ];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const s = io(BASE, { transports: ['websocket'] });
    sockets.push(s);
    const res = await new Promise<{ playerId?: number }>((resolve) => {
      s.emit('join', { code, name: names[i % names.length] }, resolve);
    });
    bots.push({ socket: s, slot: res.playerId ?? 0 });
  }
  sockets[0].on('snapshot', () => {}); // phones don't get snapshots; use a stage socket:
  const spy = io(BASE, { transports: ['websocket'] });
  sockets.push(spy);
  await new Promise<void>((resolve) => {
    spy.emit('stage:attach', { code }, () => resolve());
  });
  spy.on('snapshot', (snap: StageSnapshot) => {
    latest = snap;
  });

  // Add 10 server-driven fake players from the host bar.
  await page.click('.bot-controls button:has-text("+10")');
  await sleep(600);
  await page.screenshot({ path: path.join(OUT_DIR, '1-lobby.png') });
  console.log('lobby captured');

  // --- Last One Standing ---
  await page.click('button.start-los');
  await sleep(3600); // countdown
  const wiggle = setInterval(() => {
    for (const bot of bots) {
      const a = Math.random() * Math.PI * 2;
      bot.socket.emit('input', { t: 'joy', x: Math.cos(a) * 0.9, y: Math.sin(a) * 0.9 });
    }
  }, 400);
  await sleep(4000);
  await page.screenshot({ path: path.join(OUT_DIR, '2-last-one-standing.png') });
  clearInterval(wiggle);
  console.log('LOS captured');

  // --- Team Puzzles ---
  await page.click('.host-corner button:has-text("Lobby")');
  await sleep(400);
  await page.click('button.start-puzzle');
  await sleep(3600); // countdown

  // Steer two teams to completion for confetti/locked visuals (BFS around
  // occupied cells, anchors clear of board corners); other pieces roam.
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
        let cur = cell;
        for (;;) {
          const p = prev.get(cur)!;
          if (p === key(fromX, fromY)) break;
          if (p === -1) return null;
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
    const snap = latest as PuzzleSnapshot | null;
    if (!snap || snap.kind !== 'puzzle' || snap.phase === 'countdown') return;
    const byId = new Map(snap.pieces.map((p) => [p.id, p] as const));
    const occupied = new Set<number>(snap.pieces.map((p) => p.cy * snap.cols + p.cx));
    for (const bot of bots) {
      const piece = byId.get(bot.slot);
      if (!piece || piece.locked) continue;
      if (piece.g <= 1) {
        const ox = 1 + piece.g * 3;
        const oy = 1;
        const tx = Math.min(ox + QUAD_DX[piece.q], snap.cols - 1);
        const ty = oy + QUAD_DY[piece.q];
        if (tx === piece.cx && ty === piece.cy) {
          bot.socket.emit('input', { t: 'dir', x: 0, y: 0 });
          continue;
        }
        const step = bfsStep(snap, occupied, piece.cx, piece.cy, tx, ty);
        if (step) bot.socket.emit('input', { t: 'dir', x: step[0], y: step[1] });
      } else if (Math.random() < 0.4) {
        const a = Math.random() * Math.PI * 2;
        bot.socket.emit('input', { t: 'dir', x: Math.cos(a), y: Math.sin(a) });
      }
    }
  }, 200);
  await sleep(7000);
  await page.screenshot({ path: path.join(OUT_DIR, '3-team-puzzles.png') });
  clearInterval(solver);
  console.log('puzzle captured');

  await browser.close();
  for (const s of sockets) s.disconnect();
  killServer();
  console.log('done');
  process.exit(0);
}

function killServer() {
  if (serverProc?.pid) {
    try {
      process.kill(-serverProc.pid, 'SIGKILL');
    } catch {
      serverProc.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error(err);
  killServer();
  process.exit(1);
});
