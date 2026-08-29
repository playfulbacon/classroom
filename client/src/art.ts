// Deterministic procedural artwork for puzzle groups. The same groupId
// produces the same image on every client (stage and phones), so nothing
// but the id ever travels over the network.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<number, HTMLCanvasElement>();

export const ART_SIZE = 360;

export function groupArtCanvas(groupId: number): HTMLCanvasElement {
  const hit = cache.get(groupId);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = ART_SIZE;
  canvas.height = ART_SIZE;
  drawGroupArt(canvas.getContext('2d')!, ART_SIZE, groupId);
  cache.set(groupId, canvas);
  return canvas;
}

export function drawGroupArt(ctx: CanvasRenderingContext2D, size: number, groupId: number) {
  const rand = mulberry32(groupId * 2654435761 + 12345);
  const hue = (groupId * 137.508 + rand() * 20) % 360;
  const hue2 = (hue + 150 + rand() * 60) % 360;
  const bg = `hsl(${hue} 70% 42%)`;
  const fg = `hsl(${hue2} 85% 68%)`;
  const s = size;

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  const pattern = Math.floor(rand() * 5);
  ctx.fillStyle = fg;
  ctx.strokeStyle = fg;

  if (pattern === 0) {
    // Concentric rings from a corner
    const cx = rand() < 0.5 ? 0 : s;
    const cy = rand() < 0.5 ? 0 : s;
    ctx.lineWidth = s * 0.06;
    for (let r = s * 0.12; r < s * 1.5; r += s * 0.2) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (pattern === 1) {
    // Diagonal stripes
    ctx.lineWidth = s * 0.09;
    ctx.lineCap = 'round';
    for (let i = -1; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(-s * 0.2 + i * s * 0.28, -s * 0.2);
      ctx.lineTo(-s * 0.2 + i * s * 0.28 - s * 0.7, s * 1.2);
      ctx.stroke();
    }
  } else if (pattern === 2) {
    // Big dot grid
    const step = s / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.beginPath();
        ctx.arc(step * (x + 0.5), step * (y + 0.5), step * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (pattern === 3) {
    // Zigzag bands
    ctx.lineWidth = s * 0.07;
    ctx.lineJoin = 'round';
    for (let band = 0; band < 4; band++) {
      const y0 = s * (0.12 + band * 0.26);
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const x = (i / 8) * s;
        const y = y0 + (i % 2 === 0 ? -s * 0.06 : s * 0.06);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else {
    // Checker diamonds
    const step = s / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if ((x + y) % 2 === 0) continue;
        const cx = step * (x + 0.5);
        const cy = step * (y + 0.5);
        ctx.beginPath();
        ctx.moveTo(cx, cy - step * 0.4);
        ctx.lineTo(cx + step * 0.4, cy);
        ctx.lineTo(cx, cy + step * 0.4);
        ctx.lineTo(cx - step * 0.4, cy);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Central emblem spanning all four quadrants — the visual anchor that
  // makes fragments recognisably part of one image.
  const emblemHue = (hue + 40 + rand() * 40) % 360;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${emblemHue} 80% 60%)`;
  ctx.fill();
  ctx.lineWidth = s * 0.035;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  const glyphs = ['★', '♥', '☀', '☂', '♫', '✿', '⚡', '☾', '❄', '✈', '⚓', '☕', '⚽', '☘', '🔑', '⏰', '🎈', '🐟'];
  const glyph = glyphs[groupId % glyphs.length];
  ctx.fillStyle = 'white';
  ctx.font = `${s * 0.3}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, s / 2, s / 2 + s * 0.01);
  ctx.restore();
}

// Draw one quadrant (0 TL, 1 TR, 2 BL, 3 BR) of a group's art into a rect.
export function drawQuadrant(
  ctx: CanvasRenderingContext2D,
  groupId: number,
  quadrant: number,
  x: number,
  y: number,
  size: number,
) {
  const art = groupArtCanvas(groupId);
  const half = ART_SIZE / 2;
  const sx = quadrant % 2 === 0 ? 0 : half;
  const sy = quadrant < 2 ? 0 : half;
  ctx.drawImage(art, sx, sy, half, half, x, y, size, size);
}
