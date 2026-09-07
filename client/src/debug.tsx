// Phone-side diagnostics. A 🐞 button lives on every player screen (never
// the stage); tapping it toggles a live panel fed from the module-level
// `dbg` record — anything, anywhere in the client can write into it.
// __APP_VERSION__ (the git hash baked in by vite.config.ts) is always the
// first line, so "am I running the latest code?" has an instant answer.

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

// Live diagnostic values — write freely from anywhere (cheap string writes;
// nothing renders until the panel is open).
export const dbg: Record<string, string> = {};

export function DebugCorner() {
  const location = useLocation();
  const [on, setOn] = useState(() => {
    try {
      return (
        new URLSearchParams(window.location.search).has('debug') ||
        localStorage.getItem('ca-debug') === '1'
      );
    } catch {
      return false;
    }
  });
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(iv);
  }, [on]);

  if (location.pathname === '/stage') return null;
  const toggle = () => {
    setOn((v) => {
      try {
        localStorage.setItem('ca-debug', v ? '0' : '1');
      } catch {
        // fine
      }
      return !v;
    });
  };
  return (
    <>
      <button
        className="debug-toggle"
        style={{ opacity: on ? 1 : 0.45 }}
        onClick={toggle}
        aria-label="Toggle debug overlay"
      >
        🐞
      </button>
      {on && (
        <div className="debug-panel">
          <div>
            <b>build</b> {__APP_VERSION__}
          </div>
          {Object.entries(dbg).map(([k, v]) => (
            <div key={k}>
              <b>{k}</b> {v}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
