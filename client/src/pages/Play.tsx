import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  BuzzType,
  JoinResponse,
  MedusaFieldMsg,
  MedusaShieldMsg,
  MeState,
  RoomState,
} from '../../../shared/protocol';
import { drawFragment, getRoomImage, groupArtCanvas } from '../art';
import type { GazeState, GazeTracker } from '../gaze';
import type { ShieldRenderer3D } from '../render/shield3d';
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

type GazeCamStatus = 'ask' | 'starting' | 'calibrating' | 'on' | 'off' | 'failed';

const GAZE_ICONS = ['🛡', '😑', '👁', '❔'] as const; // shield/closed/caught/unknown

// Medusa eye mode: consent card → on-device gaze tracking → quick "look at
// your phone" calibration → tiny mirrored self-preview with a live state
// icon. Detection runs entirely on the phone; only a {state, confidence}
// pair is sent. Unmounting stops the camera.
function MedusaGazeCam({ dbg }: { dbg?: React.MutableRefObject<Record<string, string>> }) {
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

  const remember = (v: 'yes' | 'no') => {
    try {
      sessionStorage.setItem('ca-eyecam', v);
    } catch {
      // fine
    }
  };

  useEffect(() => {
    if (status !== 'starting') return;
    let cancelled = false;
    void (async () => {
      const mod = await import('../gaze');
      const result = await mod.startGazeTracking((s) => {
        lastRef.current = s;
        setGaze(s);
        socket.emit('input', { t: 'gaze', s: s.s, c: Math.round(s.c * 100) / 100 });
      });
      if (cancelled) {
        if (!('error' in result)) result.stop();
        return;
      }
      if ('error' in result) {
        setFailDetail(result.detail);
        if (dbg) dbg.current['cam'] = `FAILED — ${result.detail}`;
        setStatus('failed');
        return;
      }
      trackerRef.current = result;
      result.video.className = 'eyecam-video';
      previewRef.current?.appendChild(result.video);
      setStatus('calibrating');
      await result.calibrate(1500);
      if (!cancelled) setStatus('on');
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Heartbeat so the server can tell fresh reports from a dead camera —
  // and, when the ?debug overlay is up, mirror the tracker's internals.
  useEffect(() => {
    if (status !== 'on' && status !== 'calibrating') return;
    const iv = setInterval(() => {
      const s = lastRef.current;
      if (s) socket.emit('input', { t: 'gaze', s: s.s, c: Math.round(s.c * 100) / 100 });
      if (dbg && trackerRef.current) {
        dbg.current['cam'] = status;
        Object.assign(dbg.current, trackerRef.current.debug);
        if (s) dbg.current['sent'] = `s=${s.s} c=${s.c.toFixed(2)}`;
      }
    }, 250);
    return () => clearInterval(iv);
  }, [status, dbg]);

  useEffect(
    () => () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
    },
    [],
  );

  if (status === 'ask') {
    return (
      <div className="eyecam-consent">
        <h3>👁 Medusa&apos;s rules</h3>
        <p>
          When she turns: <b>look at your phone or close your eyes.</b> Your
          camera checks where you&apos;re looking — video never leaves your
          phone, only &quot;safe or caught&quot; does.
        </p>
        <p style={{ opacity: 0.75 }}>
          No camera? Her gaze still finds you, slowly — hide behind statues.
        </p>
        <button
          className="yes"
          onClick={() => {
            remember('yes');
            setStatus('starting');
          }}
        >
          Use my camera
        </button>
        <button
          className="no"
          onClick={() => {
            remember('no');
            setStatus('off');
          }}
        >
          No camera
        </button>
      </div>
    );
  }
  if (status === 'off' || status === 'failed') {
    return (
      <div className="eyecam-chip">
        📷 {status === 'failed' ? 'camera unavailable — ' : ''}she finds you slowly:
        hide behind statues
        {status === 'failed' && failDetail && (
          <div className="eyecam-chip-detail">{failDetail}</div>
        )}
      </div>
    );
  }
  return (
    <div className="eyecam" ref={previewRef}>
      <span className="eyecam-state">
        {status === 'calibrating' ? '🎯' : GAZE_ICONS[gaze.s]}
      </span>
      {status === 'calibrating' && <span className="eyecam-cal">look at your phone…</span>}
    </div>
  );
}

// Live diagnostics for eye mode, shown when the page URL carries ?debug —
// camera pipeline state, raw detection scores, what's being sent, and what
// the server thinks of you (via the shield stream + me state).
function DebugPanel({ dbgRef }: { dbgRef: React.MutableRefObject<Record<string, string>> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="debug-panel">
      {Object.entries(dbgRef.current).map(([k, v]) => (
        <div key={k}>
          <b>{k}</b> {v}
        </div>
      ))}
    </div>
  );
}

const BUZZ_PATTERNS: Record<BuzzType, number[]> = {
  go: [60],
  bumped: [35],
  eliminated: [90, 60, 250],
  locked: [60, 50, 60, 50, 220],
  creep: [70, 40, 70], // the stone crept up a tier
};

// While Medusa watches, the phone becomes the mirrored bronze shield: the
// big screen shows only her face, so this little reflection is the player's
// whole world. It renders the field with the SAME three.js art and camera
// as the stage (lazy chunk — loaded only here), horizontally mirrored, and
// is visible only while her gaze is red; the TouchSurface stays mounted
// underneath, so inputs are identical (world-mapped) in both views.
function ShieldOverlay({
  fieldRef,
  shieldRef,
  colorsRef,
  selfSlot,
}: {
  fieldRef: React.MutableRefObject<MedusaFieldMsg | null>;
  shieldRef: React.MutableRefObject<{ msg: MedusaShieldMsg; at: number } | null>;
  colorsRef: React.MutableRefObject<Map<number, string>>;
  selfSlot: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let renderer: ShieldRenderer3D | null = null;
    void (async () => {
      const mod = await import('../render/shield3d');
      if (disposed || !boxRef.current) return;
      renderer = mod.createShieldRenderer({
        field: () => fieldRef.current,
        shield: () => shieldRef.current,
        colors: () => colorsRef.current,
        selfSlot: () => selfSlot,
      });
      renderer.mount(boxRef.current);
    })();
    return () => {
      disposed = true;
      renderer?.dispose();
    };
  }, [fieldRef, shieldRef, colorsRef, selfSlot]);
  return <div ref={boxRef} className="shield-box" />;
}

export function Play() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeState | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  // Medusa shield-view plumbing (refs — the canvas loop reads them directly).
  const fieldRef = useRef<MedusaFieldMsg | null>(null);
  const shieldRef = useRef<{ msg: MedusaShieldMsg; at: number } | null>(null);
  const colorsRef = useRef(new Map<number, string>());
  const lastMeterRef = useRef(0);
  const dbgRef = useRef<Record<string, string>>({});
  const [debugOn] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('debug');
    } catch {
      return false;
    }
  });
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
    const onField = (msg: MedusaFieldMsg) => {
      fieldRef.current = msg;
      shieldRef.current = null;
      lastMeterRef.current = 0;
    };
    const onShield = (msg: MedusaShieldMsg) => {
      shieldRef.current = { msg, at: performance.now() };
      dbgRef.current['server'] =
        `gaze=${['green', 'turning', 'RED', 'returning'][msg.g[0]]} ` +
        `meter=${msg.me[2]} tier=${msg.me[3]} ` +
        `eff=${['shield', 'closed', 'caught', 'unknown'][msg.me[4]] ?? 'classic'} ` +
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
    socket.on('field', onField);
    socket.on('shield', onShield);
    if (socket.connected) doJoin();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('me', setMe);
      socket.off('room', setRoom);
      socket.off('buzz', onBuzz);
      socket.off('field', onField);
      socket.off('shield', onShield);
    };
  }, [navigate]);

  // Slot → color for the shield view's neighbor dots.
  useEffect(() => {
    const map = new Map<number, string>();
    if (room) for (const p of room.players) map.set(p.id, p.color);
    colorsRef.current = map;
  }, [room]);

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
        {me.eyeMode && (
          <ShieldOverlay
            fieldRef={fieldRef}
            shieldRef={shieldRef}
            colorsRef={colorsRef}
            selfSlot={me.playerId}
          />
        )}
        {me.eyeMode && <MedusaGazeCam dbg={debugOn ? dbgRef : undefined} />}
        {debugOn && <DebugPanel dbgRef={dbgRef} />}
        <div className="controller-hud">
          <div className="big-num" style={{ opacity: 0.25 }}>{num}</div>
          <div className="hint">
            {me.eyeMode
              ? 'TAP to run · when she turns: LOOK AT YOUR PHONE (slow) or CLOSE YOUR EYES (fast, blind)!'
              : 'TAP to run · swipe to dodge pits · watch the big screen — FREEZE when she turns!'}
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

  return (
    <div className="status-screen">
      {reconnectBanner}
      <h2>Watch the big screen</h2>
    </div>
  );
}
