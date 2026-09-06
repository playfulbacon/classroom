// The mirrored bronze shield: what a phone shows while Medusa watches. A
// limited, degraded reflection of the field — forward is up, the lane axis
// is horizontally MIRRORED (flip the image, never the controls), and only a
// couple of hops of the world are visible inside the shield's face. All
// state feedback is diegetic on the rim: glow = safe, snakes coiling = the
// meter rising, cracks = tracking lost.
//
// Pure 2D canvas — phones never load three.js.

import type { MedusaFieldMsg, MedusaShieldMsg } from '../../../shared/protocol';

export interface ShieldData {
  field: MedusaFieldMsg;
  msg: MedusaShieldMsg;
  colors: Map<number, string>; // slot → css color
}

const VIEW_CELLS = 2.6; // world radius (in cells) visible inside the shield

export function drawShield(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ShieldData,
  now: number, // seconds, for wobble/pulse animation
) {
  const { field, msg } = data;
  const [meCol, meLane, meterQ, , gz] = msg.me;
  const R = Math.min(w, h) * 0.38;
  const cell = R / (VIEW_CELLS + 0.4);
  // Soft hand-wobble: the whole reflection sways a little.
  const cx = w / 2 + Math.sin(now * 1.1) * 3;
  const cy = h / 2 + Math.cos(now * 0.9) * 3;

  const pitSet = new Set(field.pits.map(([c, l]) => l * 1000 + c));
  const crumbleBase = new Set(field.crumble.map(([c, l]) => l * 1000 + c));
  const crumbleNow = new Map(msg.cr.map(([c, l, st]) => [l * 1000 + c, st]));
  const platformDefs = new Map(field.platforms.map((p) => [p.id, p]));

  // World cell → screen. Forward (higher col) is UP; the lane axis is
  // mirrored; a slight radial warp gives the polished-metal convexity.
  const toScreen = (c: number, l: number): [number, number, number] => {
    let x = -(l - meLane) * cell;
    let y = -(c - meCol) * cell;
    const r = Math.hypot(x, y);
    const f = 1 + 0.14 * (r / R) * (r / R);
    x *= f;
    y *= f;
    return [cx + x, cy + y, f];
  };

  ctx.save();

  // Shield face: clip + bronze base.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  const base = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R);
  base.addColorStop(0, '#4a3c26');
  base.addColorStop(0.65, '#33291a');
  base.addColorStop(1, '#171208');
  ctx.fillStyle = base;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // Ground cells within view.
  const range = Math.ceil(VIEW_CELLS) + 1;
  for (let c = meCol - range; c <= meCol + range; c++) {
    for (let l = meLane - range; l <= meLane + range; l++) {
      if (c < 0 || c >= field.length || l < 0 || l >= field.lanes) continue;
      const key = l * 1000 + c;
      const [sx, sy, f] = toScreen(c, l);
      const size = cell * 0.92 * f;
      let fill = 'rgba(120, 128, 96, 0.28)'; // warm low-contrast ground
      if (c === field.length - 1) fill = 'rgba(216, 182, 74, 0.5)'; // finish gold
      if (pitSet.has(key)) fill = 'rgba(0, 0, 0, 0.72)';
      const crSt = crumbleNow.get(key) ?? (crumbleBase.has(key) ? 0 : -1);
      if (crSt === 0) fill = 'rgba(140, 128, 84, 0.34)';
      else if (crSt === 1) fill = 'rgba(96, 82, 50, 0.55)';
      else if (crSt === 2) fill = 'rgba(0, 0, 0, 0.72)';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      if (crSt === 0 || crSt === 1) {
        // hairline cracks so crumble reads even in bronze
        ctx.strokeStyle = `rgba(30, 24, 12, ${crSt === 1 ? 0.9 : 0.45})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.3, sy - size * 0.25);
        ctx.lineTo(sx + size * 0.1, sy + size * 0.1);
        ctx.lineTo(sx + size * 0.3, sy + size * 0.35);
        ctx.stroke();
      }
    }
  }

  // Ferries in view.
  for (const [id, pos] of msg.pf) {
    const def = platformDefs.get(id);
    if (!def) continue;
    const [sx, sy, f] = toScreen(pos, def.lane);
    const size = cell * 0.86 * f;
    ctx.fillStyle = 'rgba(196, 140, 74, 0.9)';
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
  }

  // Neighbors: runners as tinted dots, statues gray.
  for (const [slot, c, l, state, tier] of msg.near) {
    const [sx, sy, f] = toScreen(c, l);
    const rad = cell * 0.26 * f;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    if (state === 1) {
      ctx.fillStyle = '#9a9aa6';
    } else {
      const color = data.colors.get(slot) ?? '#cfc7b0';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9 - tier * 0.15;
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    if (state === 1) {
      // little statue base so the dead read as cover
      ctx.fillStyle = 'rgba(60, 60, 70, 0.8)';
      ctx.fillRect(sx - rad, sy + rad * 0.6, rad * 2, rad * 0.5);
    }
  }

  // Self: center-locked, ringed.
  {
    const rad = cell * 0.3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Medusa dim at the top rim when the finish is near.
  const toGo = field.length - 1 - meCol;
  if (toGo <= 5) {
    const gy = cy - R * 0.82;
    ctx.globalAlpha = 0.5 - toGo * 0.06;
    ctx.fillStyle = '#5f8a4e';
    ctx.beginPath();
    ctx.arc(cx, gy, R * 0.16, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.14, gy + Math.sin(a) * R * 0.14);
      ctx.lineTo(cx + Math.cos(a) * R * 0.24, gy + Math.sin(a) * R * 0.24);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#3f6b3a';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Inner vignette: the reflection dies toward the rim.
  const vin = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
  vin.addColorStop(0, 'rgba(0,0,0,0)');
  vin.addColorStop(1, 'rgba(8, 5, 0, 0.85)');
  ctx.fillStyle = vin;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();

  // --- Diegetic rim -------------------------------------------------------
  // Glow color carries the player's own state; snakes coil around it as the
  // meter rises; cracks spread when tracking is lost.
  const rimColor =
    gz === 0
      ? 'rgba(125, 255, 155, 0.9)' // shield up — safe
      : gz === 1
        ? 'rgba(120, 170, 255, 0.9)' // eyes closed (spectator info)
        : gz === 2
          ? `rgba(255, 60, 70, ${0.6 + 0.4 * Math.abs(Math.sin(now * 9))})` // caught!
          : 'rgba(150, 150, 150, 0.75)'; // unknown
  ctx.lineWidth = 7;
  ctx.strokeStyle = rimColor;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 5, 0, Math.PI * 2);
  ctx.stroke();
  // bronze outer band
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#6b4f26';
  ctx.beginPath();
  ctx.arc(cx, cy, R + 11, 0, Math.PI * 2);
  ctx.stroke();

  // Snakes coil with the meter: a dark-green arc creeping around the rim.
  if (meterQ > 2) {
    const sweep = (meterQ / 100) * Math.PI * 2;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(52, 92, 44, 0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, -Math.PI / 2, -Math.PI / 2 + sweep);
    ctx.stroke();
    // snake head
    const hx = cx + Math.cos(-Math.PI / 2 + sweep) * (R + 8);
    const hy = cy + Math.sin(-Math.PI / 2 + sweep) * (R + 8);
    ctx.fillStyle = '#89c46b';
    ctx.beginPath();
    ctx.arc(hx, hy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = 'butt';
  }

  // Tracking lost: cracks spread across the shield.
  if (gz === 3) {
    ctx.strokeStyle = 'rgba(200, 200, 210, 0.5)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.7;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3);
      ctx.lineTo(cx + Math.cos(a + 0.25) * R * 0.65, cy + Math.sin(a + 0.25) * R * 0.65);
      ctx.lineTo(cx + Math.cos(a + 0.15) * R * 0.95, cy + Math.sin(a + 0.15) * R * 0.95);
      ctx.stroke();
    }
  }
}
