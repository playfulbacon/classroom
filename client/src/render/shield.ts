// The bronze shield's RIM: the physical frame around the phone's mirrored
// 3D reflection (shield3d.ts renders the field itself). Drawn on an
// unmirrored 2D canvas above the WebGL view. All state feedback is
// diegetic here: glow color = your own gaze state, snakes coil around the
// rim as your death meter rises, cracks spread when tracking is lost, and
// Medusa looms dim at the top rim as you near the finish.

// Fraction of min(w,h) that is the shield's visible hole radius. Shared
// with shield3d's camera math so the hole and the frustum cannot disagree.
export const SHIELD_HOLE_FRAC = 0.38;

export interface ShieldRimState {
  gz: number; // own gaze code (0 shield / 1 closed / 2 caught / 3 unknown)
  meterQ: number; // death meter 0..100 → snake arc sweep
  toGo: number; // columns to the finish → Medusa silhouette fade-in
}

export function drawShieldRim(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rim: ShieldRimState,
  now: number, // seconds, for pulse animation
) {
  const R = Math.min(w, h) * SHIELD_HOLE_FRAC;
  const cx = w / 2;
  const cy = h / 2;

  // Everything outside the shield face is darkness (evenodd punch-out).
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgb(9, 6, 3)';
  ctx.fill('evenodd');

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  // A faint warm cast + edge vignette so the reflection reads as bronze.
  const tint = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R);
  tint.addColorStop(0, 'rgba(255, 214, 150, 0.10)');
  tint.addColorStop(0.7, 'rgba(120, 84, 40, 0.10)');
  tint.addColorStop(1, 'rgba(30, 18, 6, 0.28)');
  ctx.fillStyle = tint;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  const vin = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
  vin.addColorStop(0, 'rgba(0,0,0,0)');
  vin.addColorStop(1, 'rgba(8, 5, 0, 0.7)');
  ctx.fillStyle = vin;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // Medusa dim at the top rim when the finish is near.
  if (rim.toGo <= 5) {
    const gy = cy - R * 0.82;
    ctx.globalAlpha = Math.max(0, 0.5 - rim.toGo * 0.06);
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
  ctx.restore();

  // --- Diegetic rim -------------------------------------------------------
  const rimColor =
    rim.gz === 0
      ? 'rgba(125, 255, 155, 0.9)' // shield up — safe
      : rim.gz === 1
        ? 'rgba(120, 170, 255, 0.9)' // eyes closed (spectator info)
        : rim.gz === 2
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
  if (rim.meterQ > 2) {
    const sweep = (rim.meterQ / 100) * Math.PI * 2;
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
  if (rim.gz === 3) {
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
