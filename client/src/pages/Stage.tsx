import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { RoomState, StageSnapshot } from '../../../shared/protocol';
import { LosRenderer } from '../render/los';
import { PuzzleRenderer } from '../render/puzzle';
import { socket } from '../socket';

export function Stage() {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [qr, setQr] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomRef = useRef<RoomState | null>(null);
  const snapRef = useRef<StageSnapshot | null>(null);
  const losRef = useRef(new LosRenderer());
  const puzzleRef = useRef(new PuzzleRenderer());

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
    const onRoom = (r: RoomState) => {
      roomRef.current = r;
      setRoom(r);
      if (r.phase === 'lobby') {
        snapRef.current = null;
        losRef.current = new LosRenderer();
        puzzleRef.current = new PuzzleRenderer();
      }
    };
    const onSnapshot = (s: StageSnapshot) => {
      snapRef.current = s;
      if (s.kind === 'los') losRef.current.push(s);
      else puzzleRef.current.push(s);
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
        else puzzleRef.current.draw(ctx, cssW, cssH, r);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const start = (game: 'los' | 'puzzle') => {
    socket.emit('host:start', {
      game,
      options: { rotation: room?.options.rotation ?? false },
    });
  };

  const setRotation = (rotation: boolean) => {
    if (!room) return;
    // Options are applied at round start; keep the local copy in sync so the
    // checkbox reflects what the next round will use.
    setRoom({ ...room, options: { ...room.options, rotation } });
    roomRef.current = { ...room, options: { ...room.options, rotation } };
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

  return (
    <div className="stage">
      <canvas ref={canvasRef} />
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
                  {String(p.id).padStart(2, '0')} {p.name}
                </span>
              </div>
            ))}
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
            <label>
              <input
                type="checkbox"
                checked={room.options.rotation}
                onChange={(e) => setRotation(e.target.checked)}
              />
              piece rotation
            </label>
          </div>
        </div>
      )}
      {room.phase === 'playing' && (
        <div className="host-corner">
          {room.game && (
            <button onClick={() => start(room.game as 'los' | 'puzzle')}>🔁 Replay</button>
          )}
          <button onClick={() => socket.emit('host:lobby')}>🏠 Lobby</button>
        </div>
      )}
    </div>
  );
}
