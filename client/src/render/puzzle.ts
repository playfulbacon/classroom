import type { PuzzleSnapshot, RoomState } from '../../../shared/protocol';
import { drawQuadrant, groupArtCanvas } from '../art';
import { roundRect } from './los';

interface DisplayPiece {
  x: number; // display position in cell units
  y: number;
  rot: number; // degrees
  nudgeX: number;
  nudgeY: number;
  lockedAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  at: number;
}

export class PuzzleRenderer {
  private snap: PuzzleSnapshot | null = null;
  private display = new Map<number, DisplayPiece>();
  private particles: Particle[] = [];
  private seenFinished = new Set<number>();
  private lastNow = 0;
  private goShownAt = 0;
  private lastPhase = '';

  push(snap: PuzzleSnapshot) {
    const now = performance.now();
    if (snap.phase === 'play' && this.lastPhase === 'countdown') this.goShownAt = now;
    this.lastPhase = snap.phase;
    this.snap = snap;
    for (const g of snap.finished) {
      if (this.seenFinished.has(g)) continue;
      this.seenFinished.add(g);
      // Confetti burst at the assembled group's centre.
      const members = snap.pieces.filter((p) => p.g === g);
      if (members.length > 0) {
        const cx = members.reduce((a, p) => a + p.cx, 0) / members.length + 0.5;
        const cy = members.reduce((a, p) => a + p.cy, 0) / members.length + 0.5;
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * Math.PI * 2;
          const speed = 2 + Math.random() * 5;
          this.particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed - 2,
            color: `hsl(${Math.random() * 360} 90% 65%)`,
            at: now,
          });
        }
        for (const m of members) {
          const d = this.display.get(m.id);
          if (d) d.lockedAt = now;
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, _room: RoomState | null) {
    const snap = this.snap;
    if (!snap) return;
    const now = performance.now();
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0.016;
    this.lastNow = now;

    ctx.clearRect(0, 0, w, h);

    const topHud = h * 0.075;
    const margin = Math.min(w, h) * 0.03;
    const cell = Math.min(
      (w - margin * 2) / snap.cols,
      (h - margin * 2 - topHud) / snap.rows,
    );
    const boardW = cell * snap.cols;
    const boardH = cell * snap.rows;
    const ox = (w - boardW) / 2;
    const oy = topHud + (h - topHud - boardH) / 2;

    // Board.
    roundRect(ctx, ox - 10, oy - 10, boardW + 20, boardH + 20, 16);
    ctx.fillStyle = '#1a2038';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let x = 1; x < snap.cols; x++) {
      ctx.beginPath();
      ctx.moveTo(ox + x * cell, oy);
      ctx.lineTo(ox + x * cell, oy + boardH);
      ctx.stroke();
    }
    for (let y = 1; y < snap.rows; y++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * cell);
      ctx.lineTo(ox + boardW, oy + y * cell);
      ctx.stroke();
    }

    // Ease display state toward targets.
    const ease = 1 - Math.exp(-11 * dt);
    const easeFast = 1 - Math.exp(-18 * dt);
    for (const p of snap.pieces) {
      let d = this.display.get(p.id);
      if (!d) {
        d = { x: p.cx, y: p.cy, rot: p.rot * 90, nudgeX: 0, nudgeY: 0, lockedAt: 0 };
        this.display.set(p.id, d);
      }
      d.x += (p.cx - d.x) * ease;
      d.y += (p.cy - d.y) * ease;
      let target = p.rot * 90;
      while (target - d.rot > 180) target -= 360;
      while (target - d.rot < -180) target += 360;
      d.rot += (target - d.rot) * easeFast;
      d.nudgeX += (p.nx * 0.18 - d.nudgeX) * easeFast;
      d.nudgeY += (p.ny * 0.18 - d.nudgeY) * easeFast;
    }

    // Locked pieces underneath, movers on top.
    const sorted = [...snap.pieces].sort(
      (a, b) => Number(a.locked === false) - Number(b.locked === false),
    );
    const pad = cell * 0.05;
    for (const p of sorted) {
      const d = this.display.get(p.id)!;
      const px = ox + (d.x + d.nudgeX) * cell;
      const py = oy + (d.y + d.nudgeY) * cell;
      const cxp = px + cell / 2;
      const cyp = py + cell / 2;
      let size = cell - pad * 2;
      if (d.lockedAt && now - d.lockedAt < 350) {
        const t = (now - d.lockedAt) / 350;
        size *= 1 + 0.18 * Math.sin(Math.PI * t);
      }
      ctx.save();
      ctx.translate(cxp, cyp);
      ctx.rotate((d.rot * Math.PI) / 180);
      if (p.active && !p.locked) {
        ctx.shadowColor = 'rgba(255,255,255,0.95)';
        ctx.shadowBlur = cell * 0.45;
      } else if (p.locked) {
        ctx.shadowColor = 'rgba(255,214,102,0.5)';
        ctx.shadowBlur = cell * 0.2;
      }
      roundRect(ctx, -size / 2, -size / 2, size, size, size * 0.12);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.clip();
      drawQuadrant(ctx, p.g, p.q, -size / 2, -size / 2, size);
      ctx.restore();
      // Border drawn outside the clip.
      ctx.save();
      ctx.translate(cxp, cyp);
      ctx.rotate((d.rot * Math.PI) / 180);
      roundRect(ctx, -size / 2, -size / 2, size, size, size * 0.12);
      ctx.lineWidth = Math.max(2, cell * 0.045);
      ctx.strokeStyle = p.locked ? '#ffd666' : 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.restore();
    }

    // Confetti.
    this.particles = this.particles.filter((pt) => now - pt.at < 1400);
    for (const pt of this.particles) {
      pt.vy += 9 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      const life = 1 - (now - pt.at) / 1400;
      ctx.globalAlpha = life;
      ctx.fillStyle = pt.color;
      ctx.fillRect(ox + pt.x * cell - 3, oy + pt.y * cell - 3, 7, 7);
    }
    ctx.globalAlpha = 1;

    this.drawHud(ctx, w, h, snap, now);
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    snap: PuzzleSnapshot,
    now: number,
  ) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `700 ${Math.round(h * 0.032)}px system-ui`;
    ctx.fillText(
      `🧩 Teams done: ${snap.finished.length} / ${snap.groupCount}`,
      h * 0.03,
      h * 0.02,
    );

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (snap.phase === 'countdown' && snap.countdown > 0) {
      ctx.font = `800 ${Math.round(h * 0.3)}px system-ui`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(String(snap.countdown), w / 2, h / 2);
      ctx.font = `700 ${Math.round(h * 0.04)}px system-ui`;
      ctx.fillText('Find your three matching pieces!', w / 2, h * 0.78);
    } else if (this.goShownAt && now - this.goShownAt < 800) {
      ctx.font = `800 ${Math.round(h * 0.25)}px system-ui`;
      ctx.fillStyle = '#8aff9e';
      ctx.fillText('GO!', w / 2, h / 2);
    }

    if (snap.phase === 'over') {
      ctx.fillStyle = 'rgba(10,12,24,0.85)';
      const pw = w * 0.44;
      const ph = h * 0.6;
      roundRect(ctx, (w - pw) / 2, (h - ph) / 2, pw, ph, 24);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = `800 ${Math.round(h * 0.055)}px system-ui`;
      ctx.fillText('ALL PUZZLES SOLVED!', w / 2, h / 2 - ph * 0.4);
      const medals = ['🥇', '🥈', '🥉'];
      const top = snap.finished.slice(0, 5);
      top.forEach((g, i) => {
        const y = h / 2 - ph * 0.22 + i * h * 0.085;
        const art = groupArtCanvas(g);
        const iconSize = h * 0.06;
        ctx.drawImage(art, w / 2 - pw * 0.22 - iconSize / 2, y - iconSize / 2, iconSize, iconSize);
        ctx.font = `700 ${Math.round(h * 0.042)}px system-ui`;
        ctx.textAlign = 'left';
        ctx.fillText(`${medals[i] ?? `${i + 1}.`} Team ${g + 1}`, w / 2 - pw * 0.1, y);
        ctx.textAlign = 'center';
      });
    }
  }
}
