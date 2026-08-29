import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { JoinResponse } from '../../../shared/protocol';
import { loadCreds, saveCreds, socket } from '../socket';

export function Home() {
  const [params] = useSearchParams();
  const stored = loadCreds();
  const urlCode = params.get('code')?.toUpperCase() ?? '';
  const [code, setCode] = useState(urlCode || stored?.code || '');
  const [name, setName] = useState(stored?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const join = () => {
    const cleanCode = code.trim().toUpperCase();
    if (cleanCode.length !== 4) {
      setError('The room code is 4 letters — it’s on the big screen');
      return;
    }
    setBusy(true);
    setError('');
    // Reuse our token only when rejoining the same room, so a student who
    // refreshes gets their character back.
    const token = stored && stored.code === cleanCode ? stored.token : undefined;
    socket.emit('join', { code: cleanCode, name: name.trim(), token }, (res: JoinResponse) => {
      setBusy(false);
      if (!res.ok) {
        setError(res.err ?? 'Could not join');
        return;
      }
      saveCreds({ code: cleanCode, name: name.trim() || res.name || '', token: res.token });
      navigate('/play');
    });
  };

  return (
    <div className="home">
      <h1>🕹️ Classroom Arcade</h1>
      <div className="tagline">Join with the code on the big screen</div>
      <form
        className="join-form"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
          placeholder="CODE"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          inputMode="text"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder="Your name"
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Joining…' : 'Join the game'}
        </button>
        <div className="join-error">{error}</div>
      </form>
      <button className="host-link" onClick={() => navigate('/stage')}>
        Teacher? Open the big-screen stage →
      </button>
    </div>
  );
}
