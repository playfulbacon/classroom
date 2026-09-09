// Tiny synthesized sound effects (WebAudio, no asset files). Stage-only.
// Browsers require a user gesture before audio can start: call unlock() from
// a click handler (e.g. the host's Start button).

let ctx: AudioContext | null = null;

export function unlock() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function ready(): AudioContext | null {
  if (!ctx || ctx.state !== 'running') return null;
  return ctx;
}

interface ToneOpts {
  freq: number;
  end?: number; // glide target frequency
  dur: number;
  type?: OscillatorType;
  gain?: number;
  at?: number; // seconds from now
}

function tone({ freq, end, dur, type = 'sine', gain = 0.12, at = 0 }: ToneOpts) {
  const ac = ready();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (end !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t0 + dur);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise(dur: number, gain = 0.1, at = 0, lowpass = 800) {
  const ac = ready();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpass;
  const amp = ac.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(t0);
}

// Green light — bright "go" chime.
export function green() {
  tone({ freq: 660, dur: 0.09, type: 'triangle' });
  tone({ freq: 880, dur: 0.14, type: 'triangle', at: 0.09 });
}

// She's turning — ratcheting warning, the load-bearing cue.
export function warning() {
  for (let i = 0; i < 5; i++) {
    tone({ freq: 220 + i * 60, dur: 0.07, type: 'square', gain: 0.07, at: i * 0.12 });
  }
}

// Red — low sting.
export function red() {
  tone({ freq: 180, end: 90, dur: 0.4, type: 'sawtooth', gain: 0.1 });
  tone({ freq: 92, dur: 0.5, type: 'sine', gain: 0.12, at: 0.05 });
}

// Petrified — stone crack.
export function crack() {
  noise(0.18, 0.16, 0, 2500);
  tone({ freq: 140, end: 60, dur: 0.25, type: 'square', gain: 0.09 });
}

// Pit fall — descending whistle + thud.
export function fall() {
  tone({ freq: 900, end: 150, dur: 0.5, type: 'sine', gain: 0.09 });
  noise(0.12, 0.14, 0.5, 500);
}

// A runner made it — short fanfare.
export function fanfare() {
  tone({ freq: 523, dur: 0.1, type: 'triangle' });
  tone({ freq: 659, dur: 0.1, type: 'triangle', at: 0.1 });
  tone({ freq: 784, dur: 0.22, type: 'triangle', at: 0.2 });
}

// Round over.
export function gong() {
  tone({ freq: 196, dur: 1.1, type: 'sine', gain: 0.15 });
  tone({ freq: 392, dur: 0.8, type: 'sine', gain: 0.07, at: 0.05 });
}

// Human Tetris: last-seconds timer tick.
export function tick(urgent = false) {
  tone({ freq: urgent ? 1180 : 880, dur: 0.05, type: 'square', gain: 0.06 });
}

// The wall lets go — a falling whoosh.
export function whoosh(dur = 0.8) {
  tone({ freq: 1400, end: 120, dur, type: 'sawtooth', gain: 0.05 });
  noise(dur, 0.06, 0, 1800);
}

// The wall lands: a heavy thud (plus a crunch when it lands on someone).
export function thud(crunch = false) {
  tone({ freq: 70, end: 30, dur: 0.45, type: 'sine', gain: 0.22 });
  noise(0.22, 0.2, 0, 400);
  if (crunch) noise(0.14, 0.18, 0.04, 2600);
}

// An NPC scooped up — a bright little blip.
export function blip() {
  tone({ freq: 740, end: 1100, dur: 0.09, type: 'triangle', gain: 0.08 });
}

// Continuous snake hiss whose loudness follows danger (v2 red light).
// Call every frame with level 0..1; 0 fades it to silence. One shared
// looping noise source, lazily created.
let hissAmp: GainNode | null = null;
let hissCtx: AudioContext | null = null;

export function hiss(level: number) {
  const ac = ready();
  if (!ac) return;
  if (hissCtx !== ac) {
    // (Re)build after an unlock created a fresh context.
    hissCtx = ac;
    const len = Math.floor(ac.sampleRate * 1.5);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 5200; // sibilant "sss"
    filter.Q.value = 0.8;
    hissAmp = ac.createGain();
    hissAmp.gain.value = 0;
    src.connect(filter).connect(hissAmp).connect(ac.destination);
    src.start();
  }
  if (hissAmp) {
    const target = Math.max(0, Math.min(1, level)) * 0.09;
    hissAmp.gain.setTargetAtTime(target, ac.currentTime, 0.12);
  }
}
