import { io, type Socket } from 'socket.io-client';

// Same-origin connection; in dev Vite proxies /socket.io to the game server.
export const socket: Socket = io({ autoConnect: true });

export interface StoredCreds {
  code: string;
  name: string;
  token?: string;
}

const CREDS_KEY = 'ca-creds';

export function loadCreds(): StoredCreds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCreds;
    if (typeof parsed?.code !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCreds(creds: StoredCreds) {
  try {
    localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
  } catch {
    // private mode etc. — reconnection just won't survive a refresh
  }
}
