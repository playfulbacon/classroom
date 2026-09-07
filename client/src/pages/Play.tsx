import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  BuzzType,
  JoinResponse,
  MedusaPulseMsg,
  MeState,
  RoomState,
  TetrisPulseMsg,
} from '../../../shared/protocol';
import { drawFragment, getRoomImage, groupArtCanvas } from '../art';
import { dbg } from '../debug';
import type { GazeState, GazeTracker } from '../gaze';
import { loadCreds, saveCreds, socket } from '../socket';

const JOY_RADIUS = 90; // px of drag for full deflection
const EMIT_MS = 80;

interface TouchHandlers {
  onVector?: (x: number, y: number) => void;
  onRelease?: () => void;
  onFlick?: (x: number, y: number) => void;
  onTap?: () => void;
  onHold?: () => void; // long-press without moving (~450ms)
  onTouchState?: (down: boolean) => void;
}

/** Full-screen control surface: drag = joystick, quick swipe = flick, tap = tap. */
function TouchSurface({
  onVector,
  onRelease,
  onFlick,
  onTap,
  onHold,
  onTouchState,
}: TouchHandlers) {
  const originEl = useRef<HTMLDivElement>(null);
  const dotEl = useRef<HTMLDivElement>(null);
  const state = useRef({
    pointerId: -1,
    ox: 0,
    oy: 0,
    lastX: 0,
    lastY: 0,
    t0: 0,
    maxDist: 0,
    lastEmit: 0,
    holdTimer: 0 as ReturnType<typeof setTimeout> | 0,
    holdFired: false,
  });

  const showAt = (el: HTMLDivElement | null, x: number, y: number) => {
    if (!el) return;
    el.style.display = 'block';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const hide = () => {
    if (originEl.current) originEl.current.style.display = 'none';
    if (dotEl.current) dotEl.current.style.display = 'none';
  };

  const emitVector = (x: number, y: number, force: boolean) => {
    const now = performance.now();
    const s = state.current;
    if (!force && now - s.lastEmit < EMIT_MS) return;
    s.lastEmit = now;
    const dx = (x - s.ox) / JOY_RADIUS;
    const dy = (y - s.oy) / JOY_RADIUS;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) onVector?.(dx / mag, dy / mag);
    else onVector?.(dx, dy);
  };

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (s.pointerId !== -1) return; // single-touch controller
    e.currentTarget.setPointerCapture(e.pointerId);
    s.pointerId = e.pointerId;
    s.ox = e.clientX;
    s.oy = e.clientY;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.t0 = performance.now();
    s.maxDist = 0;
    s.lastEmit = 0;
    s.holdFired = false;
    if (onHold) {
      s.holdTimer = setTimeout(() => {
        if (s.pointerId !== -1 && s.maxDist < 12) {
          s.holdFired = true;
          onHold();
        }
      }, 450);
    }
    showAt(originEl.current, s.ox, s.oy);
    showAt(dotEl.current, s.ox, s.oy);
    onTouchState?.(true);
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (e.pointerId !== s.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    const dist = Math.hypot(e.clientX - s.ox, e.clientY - s.oy);
    s.maxDist = Math.max(s.maxDist, dist);
    // The thumb dot stays clamped to the joystick radius.
    const clamp = Math.min(1, JOY_RADIUS / Math.max(dist, 0.001));
    showAt(
      dotEl.current,
      s.ox + (e.clientX - s.ox) * clamp,
      s.oy + (e.clientY - s.oy) * clamp,
    );
    emitVector(e.clientX, e.clientY, false);
  };

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = state.current;
    if (e.pointerId !== s.pointerId) return;
    s.pointerId = -1;
    if (s.holdTimer) clearTimeout(s.holdTimer);
    s.holdTimer = 0;
    hide();
    const dt = performance.now() - s.t0;
    const dx = s.lastX - s.ox;
    const dy = s.lastY - s.oy;
    const dist = Math.hypot(dx, dy);
    if (!s.holdFired) {
      if (dt < 250 && dist > 55) {
        onFlick?.(dx / dist, dy / dist);
      } else if (dt < 300 && s.maxDist < 12) {
        onTap?.();
      }
    }
    onRelease?.();
    onTouchState?.(false);
  };

  return (
    <div
      className="touch-surface"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div ref={originEl} className="touch-origin" />
      <div ref={dotEl} className="touch-dot" />
    </div>
  );
}

interface PiecePreviewProps {
  group: number;
  quadrant: number;
  gw: number;
  gh: number;
  imageId?: string | null;
}

function PiecePreview({ group, quadrant, gw, gh, imageId }: PiecePreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let source: CanvasImageSource;
      let srcW: number;
      let srcH: number;
      if (imageId) {
        const code = loadCreds()?.code ?? '';
        const img = getRoomImage(code, imageId, render); // re-render on load
        if (!img) {
          ctx.fillStyle = '#39406b';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          return;
        }
        source = img;
        srcW = img.naturalWidth;
        srcH = img.naturalHeight;
      } else {
        const art = groupArtCanvas(group, gw, gh);
        source = art;
        srcW = art.width;
        srcH = art.height;
      }
      drawFragment(ctx, source, srcW, srcH, gw, gh, quadrant, 0, 0, canvas.width);
    };
    render();
    return () => {
      cancelled = true;
    };
  }, [group, quadrant, gw, gh, imageId]);
  return <canvas ref={ref} width={170} height={170} className="piece-preview" />;
}

type GazeCamStatus = 'ask' | 'starting' | 'on' | 'off' | 'failed';

const GAZE_ICONS: Record<number, string> = { 1: '😑', 2: '👁', 3: '❔' };
const GAZE_WORDS: Record<number, string> = { 1: 'closed', 2: 'OPEN', 3: 'unknown' };

// The freshest committed local eye state — shared between the camera widget,
// the playground, and the in-round feedback overlay.
const localGaze = { s: 3 as 1 | 2 | 3, at: 0 };

// Shared front-camera lifecycle: consent → on-device eyes-open detection.
// Detection runs entirely on the phone; only a {state, confidence} pair is
// ever sent (when emitToServer). Unmounting stops the camera.
function useEyeTracking(emitToServer: boolean) {
  const [status, setStatus] = useState<GazeCamStatus>(() => {
    try {
      const remembered = sessionStorage.getItem('ca-eyecam');
      if (remembered === 'yes') return 'starting';
      if (remembered === 'no') return 'off';
    } catch {
      // fine
    }
    return 'ask';
  });
  const [gaze, setGaze] = useState<GazeState>({ s: 3, c: 1 });
  const [failDetail, setFailDetail] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<GazeTracker | null>(null);
  const lastRef = useRef<GazeState | null>(null);

  useEffect(() => {
    if (status !== 'starting') return;
    let cancelled = false;
    void (async () => {
      const mod = await import('../gaze');
      const result = await mod.startGazeTracking((g) => {
        lastRef.current = g;
        localGaze.s = g.s;
        localGaze.at = performance.now();
        setGaze(g);
        if (emitToServer) {
          socket.emit('input', { t: 'gaze', s: g.s, c: Math.round(g.c * 100) / 100 });
        }
      });
      if (cancelled) {
        if (!('error' in result)) result.stop();
        return;
      }
      if ('error' in result) {
        setFailDetail(result.detail);
        dbg['cam'] = `FAILED — ${result.detail}`;
        setStatus('failed');
        return;
      }
      dbg['cam'] = 'running';
      trackerRef.current = result;
      result.video.className = 'eyecam-video';
      previewRef.current?.appendChild(result.video);
      setStatus('on');
    })();
    return () => {
      cancelled = true;
    };
  }, [status, emitToServer]);

  // Heartbeat so the server can tell fresh reports from a dead camera —
  // and the moment to mirror the tracker's live internals into the 🐞 panel.
  useEffect(() => {
    if (status !== 'on') return;
    const iv = setInterval(() => {
      const g = lastRef.current;
      if (g) {
        localGaze.s = g.s;
        localGaze.at = performance.now();
        if (emitToServer) {
          socket.emit('input', { t: 'gaze', s: g.s, c: Math.round(g.c * 100) / 100 });
        }
        dbg['sent'] = `${GAZE_WORDS[g.s]} c=${g.c.toFixed(2)}`;
      }
      if (trackerRef.current) Object.assign(dbg, trackerRef.current.debug);
    }, 250);
    return () => clearInterval(iv);
  }, [status, emitToServer]);

  useEffect(
    () => () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
    },
    [],
  );

  const choose = (v: 'yes' | 'no') => {
    try {
      sessionStorage.setItem('ca-eyecam', v);
    } catch {
      // fine
    }
    setStatus(v === 'yes' ? 'starting' : 'off');
  };
  return { status, gaze, failDetail, previewRef, choose };
}

function ConsentCard({ choose }: { choose: (v: 'yes' | 'no') => void }) {
  return (
    <div className="eyecam-consent">
      <h3>👁 Medusa&apos;s rules</h3>
      <p>
        When she turns: <b>close your eyes.</b> Your camera checks they&apos;re
        really closed — video never leaves your phone, only open/closed does.
      </p>
      <p style={{ opacity: 0.75 }}>
        No camera? Her gaze still finds you, slowly — hide behind statues.
      </p>
      <button className="yes" onClick={() => choose('yes')}>
        Use my camera
      </button>
      <button className="no" onClick={() => choose('no')}>
        No camera
      </button>
    </div>
  );
}

// The small in-round camera widget: corner self-preview + live state icon.
function MedusaGazeCam() {
  const cam = useEyeTracking(true);
  if (cam.status === 'ask') return <ConsentCard choose={cam.choose} />;
  if (cam.status === 'off' || cam.status === 'failed') {
    return (
      <div className="eyecam-chip">
        📷 {cam.status === 'failed' ? 'camera unavailable — ' : ''}she finds you
        slowly: hide behind statues
        {cam.status === 'failed' && cam.failDetail && (
          <div className="eyecam-chip-detail">{cam.failDetail}</div>
        )}
      </div>
    );
  }
  return (
    <div className="eyecam" ref={cam.previewRef}>
      <span className="eyecam-state">{GAZE_ICONS[cam.gaze.s]}</span>
    </div>
  );
}

// Demo meter rates — mirror the server's (FILL_OPEN / FILL_UNKNOWN /
// DRAIN_SAFE) so the playground teaches the real timing.
const DEMO_RATES: Record<number, number> = { 1: -1 / 1.5, 2: 1 / 1.0, 3: 1 / 2.5 };

// The sensor playground: lives on the lobby screen whenever eye mode is on,
// so every player meets the detector in a consequence-free moment — blink at
// it, close your eyes, watch the demo meter chase you — BEFORE a round ever
// puts petrification behind it. Trust is built here.
function EyePlayground() {
  const cam = useEyeTracking(false);
  const [meter, setMeter] = useState(0);
  const [gotcha, setGotcha] = useState(false);
  useEffect(() => {
    if (cam.status !== 'on') return;
    const iv = setInterval(() => {
      setMeter((m) => {
        const next = m + (DEMO_RATES[localGaze.s] ?? 0) * 0.1;
        if (next >= 1) {
          setGotcha(true);
          setTimeout(() => setGotcha(false), 1200);
          return 0;
        }
        return Math.max(0, next);
      });
    }, 100);
    return () => clearInterval(iv);
  }, [cam.status]);

  if (cam.status === 'ask') return <ConsentCard choose={cam.choose} />;
  if (cam.status === 'off' || cam.status === 'failed') {
    return (
      <div className="playground playground-unknown">
        <div className="playground-emoji">📷</div>
        <h2>No camera</h2>
        <p>
          {cam.failDetail || 'You declined the camera.'}
          <br />
          During red light her gaze will find you slowly — hide behind statues.
        </p>
      </div>
    );
  }
  const st = cam.status === 'on' ? cam.gaze.s : 3;
  const cls = st === 1 ? 'playground-safe' : st === 2 ? 'playground-seen' : 'playground-unknown';
  return (
    <div className={`playground ${cls}`}>
      {gotcha ? (
        <>
          <div className="playground-emoji">🗿</div>
          <h2>PETRIFIED!</h2>
          <p>That&apos;s what red light feels like. Close your eyes sooner!</p>
        </>
      ) : (
        <>
          <div className="playground-emoji">{GAZE_ICONS[st]}</div>
          <h2>
            {st === 1 ? 'HIDDEN' : st === 2 ? 'SHE CAN SEE YOU' : 'CAN’T FIND YOUR FACE'}
          </h2>
          <p>
            {st === 1
              ? 'Eyes closed — this is safety during red light.'
              : st === 2
                ? 'Eyes open — during red light this fills the meter below.'
                : 'Hold the phone so it sees your face. Hiding is only a slower death.'}
          </p>
        </>
      )}
      <div className="playground-meter">
        <div
          className="playground-meter-fill"
          style={{ width: `${Math.round(meter * 100)}%` }}
        />
      </div>
      <p className="playground-hint">
        Try it: blink slowly · close your eyes · cover the lens. This is exactly
        how Medusa will see you.
      </p>
      <div className="eyecam" ref={cam.previewRef} />
    </div>
  );
}

// Full-screen state feedback during an eye-mode round: the player must NEVER
// wonder what the game thinks their eyes are doing. Color floods the whole
// controller by state; the death meter is a fat bar; tier creep is spelled
// out. Pointer events pass through — the TouchSurface underneath still runs
// the character.
function FeedbackOverlay({
  pulseRef,
}: {
  pulseRef: React.MutableRefObject<{ msg: MedusaPulseMsg; at: number } | null>;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(iv);
  }, []);
  const pulse = pulseRef.current;
  const fresh = pulse && performance.now() - pulse.at < 900 ? pulse.msg : null;
  const phase = fresh ? fresh.g[0] : 0; // 0 green / 1 turning / 2 red / 3 returning
  const meterQ = fresh ? fresh.me[2] : 0;
  const tier = fresh ? fresh.me[3] : 0;
  const eyes = performance.now() - localGaze.at < 1500 ? localGaze.s : 3;

  const danger = phase === 1 || phase === 2;
  const cls = !danger
    ? 'fb-green'
    : eyes === 1
      ? 'fb-safe'
      : eyes === 2
        ? 'fb-seen'
        : 'fb-unknown';
  return (
    <div className={`feedback-overlay ${cls}`}>
      {meterQ > 2 && (
        <div className="fb-meter">
          <div className="fb-meter-fill" style={{ width: `${meterQ}%` }} />
        </div>
      )}
      {danger && (
        <div className="fb-banner">
          {eyes === 1 ? (
            <>
              <span className="fb-emoji">😑</span>
              <span>EYES CLOSED — GO! MIND THE PITS</span>
            </>
          ) : eyes === 2 ? (
            <>
              <span className="fb-emoji">👁</span>
              <span>SHE SEES YOU — CLOSE YOUR EYES!</span>
            </>
          ) : (
            <>
              <span className="fb-emoji">❔</span>
              <span>CAN&apos;T SEE YOU — SHE&apos;S COMING</span>
            </>
          )}
        </div>
      )}
      {phase === 1 && <div className="fb-sub">⚠ SHE&apos;S TURNING</div>}
      {tier > 0 && (
        <div className="fb-tier">🗿 stone up to your {tier >= 2 ? 'LEGS' : 'feet'}</div>
      )}
    </div>
  );
}

// Human Tetris full-screen feedback: the phone floods green when you're
// inside the shape and red when you're not, with the countdown huge in the
// middle — nobody should have to squint at the projector to know if they're
// safe. Pointer events pass through to the joystick underneath.
function TetrisOverlay({
  pulseRef,
}: {
  pulseRef: React.MutableRefObject<{ msg: TetrisPulseMsg; at: number } | null>;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(iv);
  }, []);
  const pulse = pulseRef.current;
  const fresh = pulse && performance.now() - pulse.at < 900 ? pulse.msg : null;
  if (!fresh) return <div className="tz-overlay tz-wait" />;
  const [inside, tLeft, phase, carrying] = fresh;
  const forming = phase === 0;
  const hurry = forming && !inside && tLeft <= 3;
  const cls = !forming ? 'tz-wait' : inside ? 'tz-safe' : `tz-out${hurry ? ' tz-hurry' : ''}`;
  return (
    <div className={`tz-overlay ${cls}`}>
      {forming ? (
        <>
          <div className={`tz-timer${tLeft <= 3 ? ' urgent' : ''}`}>{tLeft.toFixed(tLeft < 10 ? 1 : 0)}</div>
          <div className="tz-word">{inside ? '✓ SAFE — stay inside' : '✗ OUTSIDE — get in!'}</div>
        </>
      ) : (
        <div className="tz-word">{phase === 3 ? 'next shape coming…' : '⬇ THE WALL'}</div>
      )}
      {carrying === 1 && <div className="tz-carry">🙋 carrying someone — get them inside!</div>}
    </div>
  );
}

const BUZZ_PATTERNS: Record<BuzzType, number[]> = {
  go: [60],
  bumped: [35],
  eliminated: [90, 60, 250],
  locked: [60, 50, 60, 50, 220],
  creep: [70, 40, 70], // the stone crept up a tier
  warn: [110, 60, 110, 60, 200], // she's about to turn — SHUT YOUR EYES
  clear: [45, 45, 45], // she's turned away — eyes open, run
  pickup: [30, 30, 30], // Human Tetris: NPC on your shoulders
  rescued: [60, 40, 60, 40, 160], // Human Tetris: they made it
  hurry: [90, 50, 90, 50, 90], // Human Tetris: seconds left and you're OUTSIDE
};

export function Play() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeState | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  // Medusa personal-pulse plumbing (the feedback overlay reads the ref).
  const pulseRef = useRef<{ msg: MedusaPulseMsg; at: number } | null>(null);
  const tzPulseRef = useRef<{ msg: TetrisPulseMsg; at: number } | null>(null);
  const lastMeterRef = useRef(0);
  const [connected, setConnected] = useState(socket.connected);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    const creds = loadCreds();
    if (!creds) {
      navigate('/');
      return;
    }
    const doJoin = () => {
      socket.emit(
        'join',
        { code: creds.code, name: creds.name, token: creds.token },
        (res: JoinResponse) => {
          if (!res.ok) {
            setJoinError(res.err ?? 'Could not join');
            return;
          }
          saveCreds({ code: creds.code, name: creds.name, token: res.token });
          if (res.room) setRoom(res.room);
        },
      );
    };
    const onConnect = () => {
      setConnected(true);
      doJoin();
    };
    const onDisconnect = () => setConnected(false);
    const onBuzz = (type: BuzzType) => {
      try {
        navigator.vibrate?.(BUZZ_PATTERNS[type] ?? [40]);
      } catch {
        // vibration is a nice-to-have
      }
    };
    const onPulse = (msg: MedusaPulseMsg | TetrisPulseMsg) => {
      if (Array.isArray(msg)) {
        // Human Tetris: [inside, tLeft, phase, carrying]
        tzPulseRef.current = { msg, at: performance.now() };
        dbg['server'] = `${msg[0] ? 'INSIDE' : 'outside'} t=${msg[1]} ph=${msg[2]} carry=${msg[3]}`;
        return;
      }
      pulseRef.current = { msg, at: performance.now() };
      dbg['server'] =
        `gaze=${['green', 'turning', 'RED', 'returning'][msg.g[0]]} ` +
        `meter=${msg.me[2]} tier=${msg.me[3]} ` +
        `eyes=${['', 'closed', 'OPEN', 'unknown'][msg.me[4]] ?? 'classic'} ` +
        `@(${msg.me[0]},${msg.me[1]})`;
      // Escalating warning as the meter climbs: vibration at each threshold.
      const q = msg.me[2];
      const prev = lastMeterRef.current;
      lastMeterRef.current = q;
      try {
        if (prev < 90 && q >= 90) navigator.vibrate?.([120, 60, 120]);
        else if (prev < 70 && q >= 70) navigator.vibrate?.([90]);
        else if (prev < 40 && q >= 40) navigator.vibrate?.([50]);
      } catch {
        // vibration is a nice-to-have
      }
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('me', setMe);
    socket.on('room', setRoom);
    socket.on('buzz', onBuzz);
    socket.on('pulse', onPulse);
    if (socket.connected) doJoin();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('me', setMe);
      socket.off('room', setRoom);
      socket.off('buzz', onBuzz);
      socket.off('pulse', onPulse);
    };
  }, [navigate]);


  // Keep the phone screen awake during play.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const acquire = async () => {
      try {
        const wl = (navigator as any).wakeLock;
        if (wl?.request) lock = await wl.request('screen');
      } catch {
        // fine without it
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, []);

  const sendInput = useCallback((payload: unknown) => {
    socket.emit('input', payload);
  }, []);

  if (joinError) {
    return (
      <div className="status-screen">
        <h2>Hmm.</h2>
        <div className="sub">{joinError}</div>
        <button className="host-link" onClick={() => navigate('/')}>
          ← Back to join
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="status-screen">
        <h2>Joining…</h2>
        <div className="sub">{connected ? 'Waiting for the game' : 'Connecting…'}</div>
      </div>
    );
  }

  const num = String(me.playerId).padStart(2, '0');
  const tint = me.color;
  const reconnectBanner = !connected && (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        padding: 8,
        background: '#e5484d',
        textAlign: 'center',
        fontWeight: 700,
        zIndex: 50,
      }}
    >
      Reconnecting…
    </div>
  );

  // ---------------------------------------------------------------- lobby
  if (me.phase === 'lobby' || me.game === null) {
    // Eye mode on → the lobby IS the sensor playground: meet the detector
    // with nothing at stake before Medusa ever puts a meter behind it.
    if (room?.options.medusaEyes) {
      return (
        <div className="controller" style={{ background: '#0f1220' }}>
          {reconnectBanner}
          <EyePlayground />
          <div className="playground-id">
            #{String(num).padStart(2, '0')} {me.name}
          </div>
        </div>
      );
    }
    return (
      <div className="controller" style={{ background: `color-mix(in srgb, ${tint} 45%, #0f1220)` }}>
        {reconnectBanner}
        <div className="big-num">{num}</div>
        <h2>{me.name}</h2>
        <div className="hint">You’re in! Watch the big screen — the game will start soon.</div>
      </div>
    );
  }

  // ------------------------------------------------------- joined mid-round
  if (me.waiting) {
    return (
      <div className="status-screen" style={{ background: '#181d33' }}>
        {reconnectBanner}
        <div className="big-num">{num}</div>
        <h2>Hang tight</h2>
        <div className="sub">A round is already running — you’ll be in the next one.</div>
      </div>
    );
  }

  // ---------------------------------------------------- Last One Standing
  if (me.game === 'los') {
    if (me.alive === false) {
      const won = me.placement === 1;
      return (
        <div
          className="status-screen"
          style={{ background: won ? '#245c36' : '#3d1a22' }}
        >
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>{won ? '🏆 You win!' : '💥 Knocked out!'}</h2>
          <div className="sub">
            {me.placement ? `You finished #${me.placement}.` : ''} Watch the big screen!
          </div>
        </div>
      );
    }
    if (me.placement === 1) {
      return (
        <div className="status-screen" style={{ background: '#245c36' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🏆 Last one standing!</h2>
          <div className="sub">Take a bow.</div>
        </div>
      );
    }
    return (
      <div className="controller" style={{ background: `color-mix(in srgb, ${tint} 30%, #0f1220)` }}>
        {reconnectBanner}
        <TouchSurface
          onVector={(x, y) => sendInput({ t: 'joy', x, y })}
          onRelease={() => sendInput({ t: 'joy', x: 0, y: 0 })}
          onFlick={(x, y) => sendInput({ t: 'dash', x, y })}
        />
        <div className="controller-hud">
          <div className="big-num" style={{ opacity: 0.25 }}>{num}</div>
          <div className="hint">Hold &amp; drag to move · quick flick to DASH</div>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- Team Puzzles
  if (me.game === 'puzzle') {
    if (me.teamRank) {
      return (
        <div className="status-screen" style={{ background: '#245c36' }}>
          {reconnectBanner}
          {me.group !== undefined && me.quadrant !== undefined && (
            <PiecePreview
              group={me.group}
              quadrant={me.quadrant}
              gw={me.gw ?? 2}
              gh={me.gh ?? 2}
              imageId={me.imageId}
            />
          )}
          <h2>🧩 Team complete!</h2>
          <div className="sub">Your team finished #{me.teamRank}.</div>
        </div>
      );
    }
    return (
      <div className="controller" style={{ background: '#131728' }}>
        {reconnectBanner}
        <TouchSurface
          onVector={(x, y) => sendInput({ t: 'dir', x, y })}
          onRelease={() => sendInput({ t: 'dir', x: 0, y: 0 })}
          onTap={me.rotationEnabled ? () => sendInput({ t: 'rot' }) : undefined}
          onTouchState={(down) => sendInput({ t: 'touch', down })}
        />
        <div className="controller-hud">
          <div className="hint">
            This is YOUR piece — find its {(me.gw ?? 2) * (me.gh ?? 2) - 1} partners on the big
            screen
          </div>
          {me.group !== undefined && me.quadrant !== undefined && (
            <PiecePreview
              group={me.group}
              quadrant={me.quadrant}
              gw={me.gw ?? 2}
              gh={me.gh ?? 2}
              imageId={me.imageId}
            />
          )}
          <div className="hint">
            Swipe &amp; hold to slide{me.rotationEnabled ? ' · tap to rotate' : ''}
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- Medusa
  if (me.game === 'medusa') {
    const st = me.medusaState ?? 'running';
    if (st === 'stone') {
      return (
        <div className="status-screen" style={{ background: '#3a3a44' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🗿 Petrified!</h2>
          <div className="sub">
            {me.eyeMode
              ? 'Her gaze found you. You’re part of the garden now.'
              : 'Medusa saw you move. You’re part of the garden now.'}
          </div>
        </div>
      );
    }
    if (st === 'fallen') {
      return (
        <div className="status-screen" style={{ background: '#1c1410' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🕳 You fell!</h2>
          <div className="sub">
            A hop into open air — the pit swallowed you. The ground doesn’t
            forgive, especially when your eyes are closed.
          </div>
        </div>
      );
    }
    if (st === 'finished') {
      return (
        <div className="status-screen" style={{ background: '#245c36' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🏁 You escaped!</h2>
          <div className="sub">{me.placement ? `Finished #${me.placement}.` : ''} Watch the rest!</div>
        </div>
      );
    }
    const progress = Math.min(
      1,
      (me.col ?? 0) / Math.max(1, (me.fieldLength ?? 24) - 1),
    );
    return (
      <div className="controller" style={{ background: `color-mix(in srgb, ${tint} 30%, #0f1220)` }}>
        {reconnectBanner}
        <TouchSurface
          onTap={() => sendInput({ t: 'hop', d: 'f' })}
          onFlick={(x, y) => {
            // Swipes map to the world axes AS THEY APPEAR on the iso camera
            // grid: forward reads as right-and-slightly-up on screen, the
            // lane axis as down-right (screen y grows downward here).
            const fScore = x * 0.85 - y * 0.31; // world +x (toward Medusa)
            const rScore = x * 0.53 + y * 0.5; // world +z (lane + 1)
            const d =
              Math.abs(fScore) >= Math.abs(rScore)
                ? fScore > 0
                  ? 'f'
                  : 'b'
                : rScore > 0
                  ? 'r'
                  : 'l';
            sendInput({ t: 'hop', d });
          }}
          onHold={() => sendInput({ t: 'ping' })}
        />
        {me.eyeMode && <FeedbackOverlay pulseRef={pulseRef} />}
        {me.eyeMode && <MedusaGazeCam />}
        <div className="controller-hud">
          <div className="big-num" style={{ opacity: 0.25 }}>{num}</div>
          <div className="hint">
            {me.eyeMode
              ? 'TAP to run · pits are DEADLY · CLOSE YOUR EYES when she turns and run blind!'
              : 'TAP to run · pits are DEADLY · watch the big screen — FREEZE when she turns!'}
          </div>
          <div className="hint" style={{ opacity: 0.7 }}>
            Press &amp; hold to make your runner wave 👋
          </div>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress * 100}%`, background: tint }} />
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------- Human Tetris
  if (me.game === 'tetris') {
    const cleared = me.cleared ?? 0;
    if (me.tetrisState === 'out') {
      return (
        <div className="status-screen" style={{ background: '#3d1a22' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🧱 Flattened!</h2>
          <div className="sub">
            The wall got you in round {me.round ?? '?'}. Cheer the others on — they’re
            playing for everyone.
          </div>
          {me.gameOver && <div className="sub">The crowd cleared {cleared} round{cleared === 1 ? '' : 's'}.</div>}
        </div>
      );
    }
    if (me.gameOver) {
      return (
        <div className="status-screen" style={{ background: '#245c36' }}>
          {reconnectBanner}
          <div className="big-num">{num}</div>
          <h2>🧱 Still standing!</h2>
          <div className="sub">
            The crowd cleared {cleared} round{cleared === 1 ? '' : 's'} before the wall won.
          </div>
        </div>
      );
    }
    return (
      <div className="controller" style={{ background: `color-mix(in srgb, ${tint} 30%, #0f1220)` }}>
        {reconnectBanner}
        <TouchSurface
          onVector={(x, y) => sendInput({ t: 'joy', x, y })}
          onRelease={() => sendInput({ t: 'joy', x: 0, y: 0 })}
          onTap={() => sendInput({ t: 'ping' })}
        />
        <TetrisOverlay pulseRef={tzPulseRef} />
        <div className="tz-round">
          #{num} {me.name} · round {me.round ?? 0} · {cleared} cleared
        </div>
        <div className="controller-hud" style={{ justifyContent: 'flex-end', paddingBottom: 40 }}>
          <div className="hint">
            Swipe anywhere to move · TAP to make your character jump 👋
          </div>
          <div className="hint" style={{ opacity: 0.7 }}>
            Touch a lost 🙋 to carry them — bring them inside the shape too
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="status-screen">
      {reconnectBanner}
      <h2>Watch the big screen</h2>
    </div>
  );
}
