// Puzzle artwork helpers.
//
// A team's picture is either a teacher-uploaded image (fetched from
// /art/{roomCode}/{imageId}) or deterministic procedural art seeded by the
// group id — the same seed produces the same image on every client, so only
// ids ever travel over the network. Pictures are stored aspect-preserving and
// center crop-to-filled to the puzzle's gw:gh cell grid at render time, then
// sliced so each cell is one piece.

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

// ---------------------------------------------------------------------------
// Procedural group art (fallback when a team has no uploaded picture)
// ---------------------------------------------------------------------------

const CELL_PX = 150; // procedural art resolution per puzzle cell

const artCache = new Map<string, HTMLCanvasElement>();

export function groupArtCanvas(groupId: number, gw: number, gh: number): HTMLCanvasElement {
  const key = `${groupId}:${gw}x${gh}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = gw * CELL_PX;
  canvas.height = gh * CELL_PX;
  drawGroupArt(canvas.getContext('2d')!, canvas.width, canvas.height, groupId);
  artCache.set(key, canvas);
  return canvas;
}

export function drawGroupArt(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  groupId: number,
) {
  const rand = mulberry32(groupId * 2654435761 + 12345);
  const hue = (groupId * 137.508 + rand() * 20) % 360;
  const hue2 = (hue + 150 + rand() * 60) % 360;
  const bg = `hsl(${hue} 70% 42%)`;
  const fg = `hsl(${hue2} 85% 68%)`;
  const s = Math.min(w, h); // pattern scale unit

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const pattern = Math.floor(rand() * 5);
  ctx.fillStyle = fg;
  ctx.strokeStyle = fg;

  if (pattern === 0) {
    // Concentric rings from a corner
    const cx = rand() < 0.5 ? 0 : w;
    const cy = rand() < 0.5 ? 0 : h;
    ctx.lineWidth = s * 0.06;
    const maxR = Math.hypot(w, h);
    for (let r = s * 0.12; r < maxR; r += s * 0.2) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (pattern === 1) {
    // Diagonal stripes
    ctx.lineWidth = s * 0.09;
    ctx.lineCap = 'round';
    const step = s * 0.28;
    for (let x = -h; x < w + h; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, -s * 0.1);
      ctx.lineTo(x - h, h + s * 0.1);
      ctx.stroke();
    }
  } else if (pattern === 2) {
    // Big dot grid
    const step = s / 4;
    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, step * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (pattern === 3) {
    // Zigzag bands
    ctx.lineWidth = s * 0.07;
    ctx.lineJoin = 'round';
    const bandStep = s * 0.26;
    const segs = Math.max(8, Math.round((w / s) * 8));
    for (let y0 = s * 0.12; y0 < h + bandStep; y0 += bandStep) {
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) {
        const x = (i / segs) * w;
        const y = y0 + (i % 2 === 0 ? -s * 0.06 : s * 0.06);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else {
    // Checker diamonds
    const step = s / 4;
    let row = 0;
    for (let y = step / 2; y < h; y += step, row++) {
      let col = 0;
      for (let x = step / 2; x < w; x += step, col++) {
        if ((col + row) % 2 === 0) continue;
        ctx.beginPath();
        ctx.moveTo(x, y - step * 0.4);
        ctx.lineTo(x + step * 0.4, y);
        ctx.lineTo(x, y + step * 0.4);
        ctx.lineTo(x - step * 0.4, y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Central emblem spanning the middle of the picture — the visual anchor
  // that makes fragments recognisably part of one image.
  const emblemHue = (hue + 40 + rand() * 40) % 360;
  const er = s * 0.3;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, er, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${emblemHue} 80% 60%)`;
  ctx.fill();
  ctx.lineWidth = s * 0.035;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();

  const glyphs = ['★', '♥', '☀', '☂', '♫', '✿', '⚡', '☾', '❄', '✈', '⚓', '☕', '⚽', '☘', '🔑', '⏰', '🎈', '🐟'];
  const glyph = glyphs[groupId % glyphs.length];
  ctx.fillStyle = 'white';
  ctx.font = `${er}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, w / 2, h / 2 + s * 0.01);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Cropping and slicing
// ---------------------------------------------------------------------------

// Source sub-rect that center crop-to-fills an aspectW:aspectH frame.
export function coverCrop(
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const target = aspectW / aspectH;
  let sw = srcW;
  let sh = srcH;
  if (srcW / srcH > target) {
    sw = srcH * target;
  } else {
    sh = srcW / target;
  }
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

// Draw one piece (cell q, reading order) of a gw x gh puzzle picture into a
// square destination rect. `source` is an uploaded image or procedural canvas.
export function drawFragment(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  gw: number,
  gh: number,
  q: number,
  dx: number,
  dy: number,
  dsize: number,
) {
  const { sx, sy, sw, sh } = coverCrop(srcW, srcH, gw, gh);
  const cellW = sw / gw;
  const cellH = sh / gh;
  const qx = q % gw;
  const qy = Math.floor(q / gw);
  ctx.drawImage(
    source,
    sx + qx * cellW,
    sy + qy * cellH,
    cellW,
    cellH,
    dx,
    dy,
    dsize,
    dsize,
  );
}

// ---------------------------------------------------------------------------
// Uploaded room images
// ---------------------------------------------------------------------------

interface ImageEntry {
  el: HTMLImageElement;
  ready: boolean;
  callbacks: (() => void)[];
}

const imageCache = new Map<string, ImageEntry>();

// Returns the loaded image, or null while it is still downloading (the load
// starts on first call). Pass onReady to be told once when it arrives.
export function getRoomImage(
  code: string,
  id: string,
  onReady?: () => void,
): HTMLImageElement | null {
  const key = `${code}/${id}`;
  let entry = imageCache.get(key);
  if (!entry) {
    const el = new Image();
    entry = { el, ready: false, callbacks: [] };
    imageCache.set(key, entry);
    el.onload = () => {
      entry!.ready = true;
      for (const cb of entry!.callbacks) cb();
      entry!.callbacks = [];
    };
    el.src = `/art/${code}/${id}`;
  }
  if (entry.ready) return entry.el;
  if (onReady) entry.callbacks.push(onReady);
  return null;
}
