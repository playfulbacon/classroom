import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  MAX_PUZZLE_DIM,
  MIN_PUZZLE_DIM,
  type GameId,
  type RoomOptions,
  type RoomState,
  type StageSnapshot,
} from '../../../shared/protocol';
import { LosRenderer } from '../render/los';
import { PuzzleRenderer } from '../render/puzzle';
import * as sfx from '../sfx';
import { socket } from '../socket';

// The 3D games (Medusa, Human Tetris) share one three.js mount and one
// lazy-loading path; each renderer is a separate code-split chunk.
type SceneKind = 'medusa' | 'tetris';

interface SceneRenderer {
  mount(container: HTMLElement): void;
  push(snap: StageSnapshot): void;
  frame(): void;
  dispose(): void;
}

const SCENE_LOADING: Record<SceneKind, string> = {
  medusa: '🐍 Summoning Medusa…',
  tetris: '🧱 Raising the wall…',
};

async function loadScene(kind: SceneKind, getRoom: () => RoomState | null): Promise<SceneRenderer> {
  if (kind === 'medusa') {
    const mod = await import('../render/medusa3d');
    const r = mod.createMedusaRenderer(getRoom, {
      // The stage owns the speakers: when the narrated intro (plus its
      // beat of silence) finishes, tell the server to start the countdown.
      onIntroDone: () => socket.emit('host:intro-done'),
    });
    return { ...r, push: (s) => s.kind === 'medusa' && r.push(s) };
  }
  const mod = await import('../render/tetris3d');
  const r = mod.createTetrisRenderer(getRoom);
  return { ...r, push: (s) => s.kind === 'tetris' && r.push(s) };
}

export function Stage() {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [qr, setQr] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneBoxRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<RoomState | null>(null);
  const snapRef = useRef<StageSnapshot | null>(null);
  const losRef = useRef(new LosRenderer());
  const puzzleRef = useRef(new PuzzleRenderer());
  const sceneRef = useRef<{ kind: SceneKind; renderer: SceneRenderer } | null>(null);
  const sceneLoadingRef = useRef(false);
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    const create = () => {
      socket.emit('stage:create', (res: { code: string }) => {
        try {
          sessionStorage.setItem('ca-stage', res.code);
        } catch {
          // fine
        }
      });
    };
    const attach = () => {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem('ca-stage');
      } catch {
        // fine
      }
      if (saved) {
        socket.emit('stage:attach', { code: saved }, (res: { ok: boolean }) => {
          if (!res.ok) create();
        });
      } else {
        create();
      }
    };
    const dropScene = () => {
      sceneRef.current?.renderer.dispose();
      sceneRef.current = null;
      setSceneReady(false);
    };
    const ensureScene = async (kind: SceneKind) => {
      if (sceneRef.current?.kind === kind || sceneLoadingRef.current) return;
      if (sceneRef.current) dropScene();
      sceneLoadingRef.current = true;
      try {
        const renderer = await loadScene(kind, () => roomRef.current);
        if (sceneBoxRef.current) renderer.mount(sceneBoxRef.current);
        sceneRef.current = { kind, renderer };
        const pending = snapRef.current;
        if (pending?.kind === kind) renderer.push(pending);
        setSceneReady(true);
      } finally {
        sceneLoadingRef.current = false;
      }
    };
    const onRoom = (r: RoomState) => {
      roomRef.current = r;
      setRoom(r);
      if (r.phase === 'lobby') {
        snapRef.current = null;
        losRef.current = new LosRenderer();
        puzzleRef.current = new PuzzleRenderer();
        dropScene();
      }
    };
    const onSnapshot = (s: StageSnapshot) => {
      snapRef.current = s;
      if (s.kind === 'los') losRef.current.push(s);
      else if (s.kind === 'puzzle') puzzleRef.current.push(s);
      else {
        const scene = sceneRef.current;
        if (scene?.kind === s.kind) scene.renderer.push(s);
        else void ensureScene(s.kind);
      }
    };
    socket.on('connect', attach);
    socket.on('room', onRoom);
    socket.on('snapshot', onSnapshot);
    if (socket.connected) attach();
    return () => {
      socket.off('connect', attach);
      socket.off('room', onRoom);
      socket.off('snapshot', onSnapshot);
    };
  }, []);

  useEffect(() => {
    if (!room?.code) return;
    const url = `${location.origin}/?code=${room.code}`;
    QRCode.toDataURL(url, { margin: 1, width: 512 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [room?.code]);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const snap = snapRef.current;
      const r = roomRef.current;
      if (r?.phase === 'playing' && snap) {
        if (snap.kind === 'los') losRef.current.draw(ctx, cssW, cssH, r);
        else if (snap.kind === 'puzzle') puzzleRef.current.draw(ctx, cssW, cssH, r);
        else if (sceneRef.current?.kind === snap.kind) sceneRef.current.renderer.frame();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const start = (game: GameId) => {
    sfx.unlock(); // user gesture — lets stage sound effects play
    socket.emit('host:start', { game, options: room?.options });
  };

  // Options live on the server (so a mid-adjustment room broadcast can't
  // reset them); update the local copy optimistically for instant feedback.
  const setOptions = (patch: Partial<RoomOptions>) => {
    if (!room) return;
    const next = { ...room, options: { ...room.options, ...patch } };
    setRoom(next);
    roomRef.current = next;
    socket.emit('host:options', next.options);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadMsg, setUploadMsg] = useState('');

  // Downscale to max 1024px JPEG before sending — keeps uploads ~100KB and
  // the original aspect, so puzzle size can change later without re-upload.
  const fileToJpeg = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const maxSide = 1024;
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not read ${file.name}`));
      };
      img.src = url;
    });

  const onFilesPicked = async (files: FileList | null) => {
    if (!files) return;
    setUploadMsg('');
    for (const file of [...files]) {
      try {
        const data = await fileToJpeg(file);
        await new Promise<void>((resolve) => {
          socket.emit('host:art:add', { data }, (res: { ok: boolean; err?: string }) => {
            if (!res.ok) setUploadMsg(res.err ?? 'Upload failed');
            resolve();
          });
        });
      } catch {
        setUploadMsg(`Could not read ${file.name}`);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  if (!room) {
    return (
      <div className="stage">
        <div className="stage-lobby">
          <h1>🕹️ Classroom Arcade</h1>
          <div style={{ color: '#9aa3c7' }}>Setting up the room…</div>
        </div>
      </div>
    );
  }

  const joinUrl = `${location.host}`;
  const botCount = room.players.filter((p) => p.bot).length;
  const { puzzleW, puzzleH } = room.options;
  const teamK = puzzleW * puzzleH;
  const teamCount = room.players.length > 0 ? Math.ceil(room.players.length / teamK) : 0;
  const canShrink = (w: number, h: number) => w >= MIN_PUZZLE_DIM && w * h >= 2;

  const sceneKind: SceneKind | null =
    room.phase === 'playing' && (room.game === 'medusa' || room.game === 'tetris')
      ? room.game
      : null;

  return (
    <div className="stage">
      <canvas ref={canvasRef} style={sceneKind ? { display: 'none' } : undefined} />
      <div
        ref={sceneBoxRef}
        className="scene-box"
        style={sceneKind ? undefined : { display: 'none' }}
      />
      {sceneKind && !sceneReady && (
        <div className="status-screen" style={{ background: 'transparent' }}>
          <h2>{SCENE_LOADING[sceneKind]}</h2>
        </div>
      )}
      {room.phase === 'lobby' && (
        <div className="stage-lobby">
          <h1>🕹️ Classroom Arcade</h1>
          <div className="lobby-join">
            {qr && <img src={qr} alt="Join QR code" />}
            <div className="lobby-code-block">
              <div className="url">
                On your phone: <b>{joinUrl}</b> — room code:
              </div>
              <div className="code">{room.code}</div>
            </div>
          </div>
          <div className="lobby-players">
            {room.players.length === 0 && (
              <div style={{ color: '#9aa3c7', fontSize: '2.6vh' }}>
                Waiting for players to join…
              </div>
            )}
            {room.players.map((p) => (
              <div key={p.id} className={`lobby-chip${p.connected ? '' : ' disconnected'}`}>
                <span className="dot" style={{ background: p.color }} />
                <span>
                  {String(p.id).padStart(2, '0')} {p.bot ? '🤖 ' : ''}
                  {p.name}
                </span>
              </div>
            ))}
          </div>
          <div className="host-dock">
          <div className="art-bar">
            <button className="add-art" onClick={() => fileInput.current?.click()}>
              📷 Add pictures
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => onFilesPicked(e.target.files)}
            />
            {room.images.map((img) => (
              <div key={img.id} className="art-thumb">
                <img src={`/art/${room.code}/${img.id}`} alt="puzzle art" />
                <button
                  onClick={() => socket.emit('host:art:remove', { id: img.id })}
                  aria-label="Remove picture"
                >
                  ✕
                </button>
              </div>
            ))}
            <span className="art-hint">
              {uploadMsg ||
                (room.images.length === 0
                  ? 'Teams without a photo get colorful patterns'
                  : teamCount > 0
                    ? `${Math.min(room.images.length, teamCount)} of ${teamCount} teams get photos`
                    : `${room.images.length} picture${room.images.length === 1 ? '' : 's'} ready`)}
            </span>
          </div>
          <div className="host-bar">
            <span className="count">
              {room.players.length} player{room.players.length === 1 ? '' : 's'}
            </span>
            <button
              className="start-los"
              disabled={room.players.length === 0}
              onClick={() => start('los')}
            >
              ⚔️ Last One Standing
            </button>
            <button
              className="start-puzzle"
              disabled={room.players.length === 0}
              onClick={() => start('puzzle')}
            >
              🧩 Team Puzzles
            </button>
            <button
              className="start-medusa"
              disabled={room.players.length === 0}
              onClick={() => start('medusa')}
            >
              🐍 Medusa
            </button>
            <button
              className="start-tetris"
              disabled={room.players.length === 0}
              onClick={() => start('tetris')}
              title="Co-op: everyone inside the shape before the wall drops. Carry the lost NPCs in with you."
            >
              🧱 Human Tetris
            </button>
            <div className="bot-controls">
              <span title="Puzzle size in cells — team size is width × height">🧩</span>
              <button
                aria-label="Narrower puzzle"
                onClick={() => setOptions({ puzzleW: puzzleW - 1 })}
                disabled={!canShrink(puzzleW - 1, puzzleH)}
              >
                −
              </button>
              <span style={{ minWidth: 20 }}>{puzzleW}</span>
              <button
                aria-label="Wider puzzle"
                onClick={() => setOptions({ puzzleW: puzzleW + 1 })}
                disabled={puzzleW >= MAX_PUZZLE_DIM}
              >
                ＋
              </button>
              <span style={{ minWidth: 14 }}>×</span>
              <button
                aria-label="Shorter puzzle"
                onClick={() => setOptions({ puzzleH: puzzleH - 1 })}
                disabled={!canShrink(puzzleH - 1, puzzleW)}
              >
                −
              </button>
              <span style={{ minWidth: 20 }}>{puzzleH}</span>
              <button
                aria-label="Taller puzzle"
                onClick={() => setOptions({ puzzleH: puzzleH + 1 })}
                disabled={puzzleH >= MAX_PUZZLE_DIM}
              >
                ＋
              </button>
              <span style={{ minWidth: 80 }}>teams of {teamK}</span>
            </div>
            <label>
              <input
                type="checkbox"
                checked={room.options.rotation}
                onChange={(e) => setOptions({ rotation: e.target.checked })}
              />
              piece rotation
            </label>
            <label title="Phones use the front camera (on-device only) — looking at Medusa during red petrifies you; eyes-closed players may keep moving">
              <input
                type="checkbox"
                checked={room.options.medusaEyes}
                onChange={(e) => setOptions({ medusaEyes: e.target.checked })}
              />
              👁 eye mode
            </label>
            {room.options.medusaEyes &&
              location.protocol === 'http:' &&
              location.hostname !== 'localhost' && (
                <span className="https-warn" title="Browsers only expose the camera to secure pages. Start with `npm run dev:https` (or deploy over HTTPS) so the QR encodes an https:// link.">
                  ⚠ phones need https for the camera
                </span>
              )}
            <div className="bot-controls">
              <button
                onClick={() => socket.emit('host:bots', { delta: -1 })}
                disabled={botCount === 0}
              >
                −
              </button>
              <span>🤖 {botCount}</span>
              <button onClick={() => socket.emit('host:bots', { delta: 1 })}>＋</button>
              <button onClick={() => socket.emit('host:bots', { delta: 10 })}>+10</button>
              <button
                onClick={() => socket.emit('host:bots', { delta: -botCount })}
                disabled={botCount === 0}
              >
                clear
              </button>
            </div>
          </div>
          </div>
        </div>
      )}
      {room.phase === 'playing' && (
        <div className="host-corner">
          {room.game && <button onClick={() => start(room.game as GameId)}>🔁 Replay</button>}
          <button onClick={() => socket.emit('host:lobby')}>🏠 Lobby</button>
        </div>
      )}
    </div>
  );
}
