import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import type { HostStartRequest, InputPayload, JoinRequest } from '../../shared/protocol';
import { Room } from './room';

const PORT = Number(process.env.PORT) || 3001;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
  // phones on flaky school wi-fi: be generous before declaring death
  pingTimeout: 30_000,
  // puzzle picture uploads arrive over the socket as base64 jpeg
  maxHttpBufferSize: 4_000_000,
});

// Teacher-uploaded puzzle pictures (kept in room memory).
app.get('/art/:code/:id', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  const image = room?.getImage(String(req.params.id));
  if (!image) {
    res.status(404).end();
    return;
  }
  res.type('jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.send(image);
});

// Serve the built client when it exists (production single-process deploy).
const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .send('Classroom Arcade server is running. Build the client (npm run build) for the full app.');
  });
}

const rooms = new Map<string, Room>();

// Unambiguous alphabet: no O/0, I/1, etc.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function roomOf(socket: Socket): Room | undefined {
  const code = socket.data.code as string | undefined;
  return code ? rooms.get(code) : undefined;
}

io.on('connection', (socket) => {
  socket.on('stage:create', (cb?: (res: { code: string }) => void) => {
    const code = generateCode();
    const room = new Room(io, code);
    rooms.set(code, room);
    room.addStage(socket);
    if (typeof cb === 'function') cb({ code });
  });

  socket.on('stage:attach', (req: { code?: string }, cb?: (res: { ok: boolean }) => void) => {
    const code = typeof req?.code === 'string' ? req.code.toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false });
      return;
    }
    room.addStage(socket);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('join', (req: JoinRequest, cb?: (res: unknown) => void) => {
    const code = typeof req?.code === 'string' ? req.code.toUpperCase().trim() : '';
    const room = rooms.get(code);
    const res = room
      ? room.join(socket, req?.name, req?.token)
      : { ok: false, err: 'No room with that code — check the big screen' };
    if (typeof cb === 'function') cb(res);
  });

  socket.on('host:start', (req: HostStartRequest) => {
    roomOf(socket)?.startGame(socket, req?.game, req?.options);
  });

  socket.on('host:lobby', () => {
    roomOf(socket)?.toLobby(socket);
  });

  socket.on('host:intro-done', () => {
    roomOf(socket)?.introDone(socket);
  });

  socket.on('host:bots', (req: { delta?: number }) => {
    roomOf(socket)?.adjustBots(socket, req?.delta);
  });

  socket.on('host:options', (req: unknown) => {
    roomOf(socket)?.setOptions(socket, req);
  });

  socket.on('host:art:add', (req: { data?: string }, cb?: (res: unknown) => void) => {
    roomOf(socket)?.addArt(socket, req?.data, cb);
  });

  socket.on('host:art:remove', (req: { id?: string }) => {
    roomOf(socket)?.removeArt(socket, req?.id);
  });

  socket.on('input', (payload: InputPayload) => {
    roomOf(socket)?.input(socket, payload);
  });

  socket.on('disconnect', () => {
    roomOf(socket)?.onDisconnect(socket);
  });
});

// Garbage-collect abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.isAbandoned(now)) {
      room.dispose();
      rooms.delete(code);
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  console.log(`Classroom Arcade server listening on :${PORT}`);
});
