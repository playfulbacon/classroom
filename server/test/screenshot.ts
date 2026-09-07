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
import type { MedusaSnapshot, PuzzleSnapshot, StageSnapshot } from '../../shared/protocol';

const PORT = 4200;
const BASE = `http://localhost:${PORT}`;
const NUM_PLAYERS = 16;
const OUT_DIR = process.argv[2] ?? 'screenshots';

let serverProc: ChildProcess | null = null;
const sockets: Socket[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// The join flow requires a camera now, so the phone page runs against
// Chromium's fake camera (auto-granted, synthetic video feed).
const FAKE_CAM_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

async function launchBrowser(): Promise<Browser> {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit, args: FAKE_CAM_ARGS });

  const containerChromium = '/opt/pw-browsers/chromium';
  if (existsSync(containerChromium)) {
    return chromium.launch({ executablePath: containerChromium, args: FAKE_CAM_ARGS });
  }

  const errors: string[] = [];
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ channel, args: FAKE_CAM_ARGS });
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
  await sleep(400);
  // Puzzle size 3x2 via the width stepper.
  await page.click('button[aria-label="Wider puzzle"]');
  await sleep(200);
  // Upload two puzzle pictures — screenshots of the page itself make handy
  // recognisable photos.
  const photo1 = await page.screenshot({ type: 'jpeg', quality: 80 });
  await page.setInputFiles('input[type=file]', {
    name: 'photo1.jpg',
    mimeType: 'image/jpeg',
    buffer: photo1,
  });
  await sleep(500);
  const photo2 = await page.screenshot({ type: 'jpeg', quality: 80, clip: { x: 300, y: 100, width: 800, height: 500 } });
  await page.setInputFiles('input[type=file]', {
    name: 'photo2.jpg',
    mimeType: 'image/jpeg',
    buffer: photo2,
  });
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
        const ox = 1 + piece.g * (snap.gw + 1);
        const oy = 1;
        const tx = Math.min(ox + pqx(piece.q, snap.gw), snap.cols - 1);
        const ty = Math.min(oy + pqy(piece.q, snap.gw), snap.rows - 1);
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
  await sleep(12000);
  await page.screenshot({ path: path.join(OUT_DIR, '3-team-puzzles.png') });
  clearInterval(solver);
  console.log('puzzle captured');

  // --- Medusa ---
  await page.click('.host-corner button:has-text("Lobby")');
  await sleep(400);
  await page.click('button.start-medusa');
  // The narrated intro: capture the rules over the visible field, then skip
  // ahead (the spy is a stage socket, so it may end the intro early).
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '4-medusa-intro.png') });
  spy.emit('host:intro-done');
  // Socket players sprint on green and dodge pits so the field spreads out.
  const medusaDriver = setInterval(() => {
    const s = latest as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa' || s.phase !== 'play' || s.gaze.state !== 'green') return;
    const pit = new Set(s.pits.map(([c, l]) => l * 1000 + c));
    const isPit = (c: number, l: number) => pit.has(l * 1000 + c);
    const pos = new Map(s.players.map((p) => [p[0], p] as const));
    for (const bot of bots) {
      const p = pos.get(bot.slot);
      if (!p || p[3] !== 0 || Math.random() < 0.35) continue;
      const [, col, lane] = p;
      if (!isPit(col + 1, lane)) bot.socket.emit('input', { t: 'hop', d: 'f' });
      else if (lane + 1 < s.lanes && !isPit(col, lane + 1)) {
        bot.socket.emit('input', { t: 'hop', d: 'r' });
      } else if (lane - 1 >= 0 && !isPit(col, lane - 1)) {
        bot.socket.emit('input', { t: 'hop', d: 'l' });
      }
    }
  }, 160);
  await sleep(8000); // chunk load + countdown + some green running
  await page.screenshot({ path: path.join(OUT_DIR, '4-medusa.png') });
  // Catch a red moment.
  const redAt = Date.now();
  while (Date.now() - redAt < 20000) {
    const s = latest as MedusaSnapshot | null;
    if (s?.kind === 'medusa' && s.gaze.state === 'red') break;
    await sleep(150);
  }
  await sleep(500); // head finishes snapping around, tint fades in
  await page.screenshot({ path: path.join(OUT_DIR, '5-medusa-red.png') });
  clearInterval(medusaDriver);
  console.log('medusa captured');

  // --- Medusa v2 (eye mode): fullscreen face cut + phone feedback wash ---
  await page.click('.host-corner button:has-text("Lobby")');
  await sleep(400);
  await page.locator('label:has-text("eye mode") input[type=checkbox]').check();
  await sleep(250);
  // A phone page for the feedback view: reuse a socket player's identity is
  // not possible (tokens are per-join), so join fresh via stored creds.
  const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await phone.goto(`${BASE}/`);
  await phone.evaluate(
    ([c]) => localStorage.setItem('ca-creds', JSON.stringify({ code: c, name: 'Perseus' })),
    [code],
  );
  await phone.goto(`${BASE}/play`);
  // The camera gate guards the join now; the fake-device flags make the
  // permission grant succeed with a synthetic feed.
  await phone.locator('button.cam-gate-btn').click({ timeout: 8000 }).catch(() => {});
  await sleep(800);
  await page.click('button.start-medusa');
  // Skip the narrated intro for this round.
  {
    const introAt = Date.now();
    while (Date.now() - introAt < 16000) {
      const s = latest as MedusaSnapshot | null;
      if (s?.kind === 'medusa') {
        if (s.phase === 'intro') spy.emit('host:intro-done');
        else break;
      }
      await sleep(150);
    }
  }
  const v2driver = setInterval(() => {
    const s = latest as MedusaSnapshot | null;
    if (!s || s.kind !== 'medusa' || s.phase !== 'play') return;
    const pit = new Set(s.pits.map(([c, l]) => l * 1000 + c));
    const pos = new Map(s.players.map((p) => [p[0], p] as const));
    bots.forEach((bot, i) => {
      const p = pos.get(bot.slot);
      if (!p || p[3] !== 0) return;
      if (i < 3) {
        // a few players hover mid-meter — caught until the stone reaches
        // their legs, then eyes shut — so tiers 1-2 stay visible on screen
        bot.socket.emit('input', { t: 'gaze', s: p[5] < 55 ? 2 : 1, c: 0.9 });
        return;
      }
      bot.socket.emit('input', { t: 'gaze', s: 1, c: 0.9 });
      if (Math.random() < 0.35) return;
      const [, col, lane] = p;
      if (!pit.has(lane * 1000 + col + 1)) bot.socket.emit('input', { t: 'hop', d: 'f' });
    });
  }, 160);
  await sleep(6000); // countdown + some green
  const v2redAt = Date.now();
  while (Date.now() - v2redAt < 25000) {
    const s = latest as MedusaSnapshot | null;
    if (s?.kind === 'medusa' && s.gaze.state === 'red' && s.gaze.tLeft > 2.4) break;
    await sleep(120);
  }
  await sleep(1800); // past the fairness grace — tiers rise, strip populates
  await page.screenshot({ path: path.join(OUT_DIR, '6-medusa-face.png') });
  // The full-screen feedback wash floods the phone during red — make sure it
  // mounted and capture the phone while she's still watching.
  await phone
    .locator('.feedback-overlay')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  await phone.screenshot({ path: path.join(OUT_DIR, '7-phone-feedback.png') });
  // Back on green the field returns — tiers decay slowly, so the stone
  // creeping up the caught starers is visible.
  const greenAt = Date.now();
  while (Date.now() - greenAt < 15000) {
    const s = latest as MedusaSnapshot | null;
    if (s?.kind === 'medusa' && s.gaze.state === 'green') break;
    await sleep(120);
  }
  await sleep(600);
  await page.screenshot({ path: path.join(OUT_DIR, '8-medusa-tiers.png') });
  clearInterval(v2driver);
  console.log('medusa v2 captured');
  await phone.close();

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
