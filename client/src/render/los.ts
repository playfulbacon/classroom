import type { LosSnapshot, RoomState } from '../../../shared/protocol';

const WORLD_R = 420; // matches server ARENA_R0
const PLAYER_R = 14;

interface TimedSnap {
  snap: LosSnapshot;
  at: number;
}

interface DeathAnim {
  slot: number;
  x: number;
  y: number;
  at: number;
}

export class LosRenderer {
  private prev: TimedSnap | null = null;
  private cur: TimedSnap | null = null;
  private lastAlive = new Map<number, [number, number]>();
  private deaths: DeathAnim[] = [];
  private goShownAt = 0;
  private lastPhase = '';

  push(snap: LosSnapshot) {
    const now = performance.now();
    // Detect eliminations for the fall animation.
    for (const [slot, x, y, alive] of snap.players) {
      if (alive) {
        this.lastAlive.set(slot, [x, y]);
      } else if (this.lastAlive.has(slot)) {
        const [lx, ly] = this.lastAlive.get(slot)!;
        this.deaths.push({ slot, x: lx, y: ly, at: now });
        this.lastAlive.delete(slot);
      }
    }
    if (snap.phase === 'play' && this.lastPhase === 'countdown') this.goShownAt = now;
    this.lastPhase = snap.phase;
    this.prev = this.cur;
    this.cur = { snap, at: now };
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, room: RoomState | null) {
    const cur = this.cur;
    if (!cur) return;
    const now = performance.now();
    const snap = cur.snap;
    const prev = this.prev;
    const interval = prev ? Math.max(16, cur.at - prev.at) : 33;
    const f = Math.min(1, (now - cur.at) / interval);

    const colors = new Map<number, string>();
    const names = new Map<number, string>();
    if (room) {
      for (const p of room.players) {
        colors.set(p.id, p.color);
        names.set(p.id, p.name);
      }
    }

    ctx.clearRect(0, 0, w, h);
    const scale = Math.min(w, h) / (2 * (WORLD_R + 60));
    const cx = w / 2;
    const cy = h / 2;
    const toX = (x: number) => cx + x * scale;
    const toY = (y: number) => cy + y * scale;

    // Original footprint (ghost ring showing how much floor is gone).
    ctx.beginPath();
    ctx.arc(cx, cy, WORLD_R * scale, 0, Math.PI * 2);
    ctx.setLineDash([8, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Arena floor.
    const r = snap.arenaR * scale;
    const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    grad.addColorStop(0, '#343c6b');
    grad.addColorStop(1, '#242a4d');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    const shrinking = snap.arenaR < WORLD_R - 1;
    ctx.lineWidth = 4;
    ctx.strokeStyle = shrinking ? '#ff5964' : 'rgba(255,255,255,0.5)';
    if (shrinking) {
      ctx.shadowColor = '#ff5964';
      ctx.shadowBlur = 18;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Bumpers.
    const bumperHot = snap.event && snap.event.kind === 'bumpers' && snap.event.warn <= 0;
    for (const ob of snap.obstacles) {
      const or = ob.r * scale;
      const bx = toX(ob.x);
      const by = toY(ob.y);
      if (bumperHot) {
        ctx.shadowColor = '#ff2d55';
        ctx.shadowBlur = 26;
      }
      const bg = ctx.createRadialGradient(bx - or * 0.3, by - or * 0.3, or * 0.2, bx, by, or);
      bg.addColorStop(0, bumperHot ? '#ff8fa3' : '#8ea2ff');
      bg.addColorStop(1, bumperHot ? '#c9184a' : '#4a5ac9');
      ctx.beginPath();
      ctx.arc(bx, by, or, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.stroke();
    }

    // Death animations (shrink + fade over 700ms).
    this.deaths = this.deaths.filter((d) => now - d.at < 700);
    for (const d of this.deaths) {
      const t = (now - d.at) / 700;
      const dr = PLAYER_R * scale * (1 - t);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(toX(d.x), toY(d.y), Math.max(dr, 0.1), 0, Math.PI * 2);
      ctx.fillStyle = colors.get(d.slot) ?? '#888';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Players (interpolated between the last two snapshots).
    const prevPos = new Map<number, [number, number]>();
    if (prev) {
      for (const [slot, x, y, alive] of prev.snap.players) {
        if (alive) prevPos.set(slot, [x, y]);
      }
    }
    const pr = PLAYER_R * scale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [slot, x, y, alive] of snap.players) {
      if (!alive) continue;
      const p = prevPos.get(slot);
      const ix = p ? p[0] + (x - p[0]) * f : x;
      const iy = p ? p[1] + (y - p[1]) * f : y;
      const px = toX(ix);
      const py = toY(iy);
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fillStyle = colors.get(slot) ?? '#999';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.font = `700 ${Math.max(10, pr * 0.95)}px system-ui`;
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 3;
      ctx.fillText(String(slot).padStart(2, '0'), px, py + 1);
      ctx.shadowBlur = 0;
    }

    this.drawHud(ctx, w, h, snap, names, now);
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    snap: LosSnapshot,
    names: Map<number, string>,
    now: number,
  ) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `700 ${Math.round(h * 0.032)}px system-ui`;
    ctx.fillText(`❤️ ${snap.aliveCount} still in`, h * 0.03, h * 0.03);

    // Event banner.
    const ev = snap.event;
    if (ev && snap.phase === 'play') {
      const warn = ev.warn > 0;
      let label = '';
      if (ev.kind === 'wind') {
        const angle = Math.atan2(ev.dy ?? 0, ev.dx ?? 0);
        const dirs = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
        const dir = dirs[(Math.round(angle / (Math.PI / 4)) + 8) % 8];
        label = warn ? `💨 WIND INCOMING ${dir}` : `💨 WIND ${dir}`;
      } else if (ev.kind === 'bumpers') {
        label = warn ? '🔴 BUMPERS CHARGING…' : '🔴 BUMPER FRENZY!';
      } else {
        label = warn ? '⚡ ENGINES CHARGING…' : '⚡ TURBO MODE!';
      }
      const pulse = warn ? 0.6 + 0.4 * Math.abs(Math.sin(now / 120)) : 1;
      ctx.globalAlpha = pulse;
      ctx.font = `800 ${Math.round(h * 0.05)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillStyle = warn ? '#ffe066' : '#ff8fa3';
      ctx.fillText(label, w / 2, h * 0.025);
      ctx.globalAlpha = 1;
    }

    // Countdown / GO!
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (snap.phase === 'countdown' && snap.countdown > 0) {
      ctx.font = `800 ${Math.round(h * 0.3)}px system-ui`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(String(snap.countdown), w / 2, h / 2);
    } else if (this.goShownAt && now - this.goShownAt < 800) {
      ctx.font = `800 ${Math.round(h * 0.25)}px system-ui`;
      ctx.fillStyle = '#8aff9e';
      ctx.fillText('GO!', w / 2, h / 2);
    }

    // Podium.
    if (snap.phase === 'over') {
      ctx.fillStyle = 'rgba(10,12,24,0.82)';
      const pw = w * 0.5;
      const ph = h * 0.42;
      roundRect(ctx, (w - pw) / 2, (h - ph) / 2, pw, ph, 24);
      ctx.fill();
      const nameOf = (slot: number) =>
        `#${String(slot).padStart(2, '0')} ${names.get(slot) ?? ''}`.trim();
      const lines: [string, string][] = [];
      if (snap.placements[0]) lines.push(['🏆', nameOf(snap.placements[0])]);
      if (snap.placements[1]) lines.push(['🥈', nameOf(snap.placements[1])]);
      if (snap.placements[2]) lines.push(['🥉', nameOf(snap.placements[2])]);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'white';
      ctx.font = `800 ${Math.round(h * 0.06)}px system-ui`;
      ctx.fillText('LAST ONE STANDING', w / 2, h / 2 - ph * 0.32);
      lines.forEach(([medal, label], i) => {
        ctx.font = `700 ${Math.round(h * 0.05 - i * h * 0.008)}px system-ui`;
        ctx.fillText(`${medal} ${label}`, w / 2, h / 2 - ph * 0.08 + i * h * 0.085);
      });
    }
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
