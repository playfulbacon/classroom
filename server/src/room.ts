import { randomBytes, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  MAX_PLAYERS,
  MAX_PUZZLE_DIM,
  MAX_ROOM_IMAGES,
  MIN_PUZZLE_DIM,
  colorForSlot,
  type BuzzType,
  type GameId,
  type InputPayload,
  type JoinResponse,
  type MeState,
  type RoomOptions,
  type RoomPhase,
  type RoomState,
  type StageSnapshot,
} from '../../shared/protocol';
import type { GameCtx, GameModule } from './games/types';
import { LastOneStanding } from './games/lastOneStanding';
import { Medusa } from './games/medusa';
import { TeamPuzzles } from './games/teamPuzzles';

interface Player {
  token: string;
  slot: number;
  name: string;
  color: string;
  socketId: string | null;
  isBot?: boolean;
}

const BOT_NAMES = [
  'Beep', 'Boop', 'Gizmo', 'Sprocket', 'Widget', 'Circuit', 'Bolt', 'Chip',
  'Servo', 'Pixel', 'Turbo', 'Gadget', 'Dynamo', 'Ratchet', 'Cog', 'Zippy',
  'Volt', 'Nano', 'Byte', 'Rusty',
];

function sanitizeName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  const clean = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return clean || fallback;
}

export class Room {
  readonly code: string;
  private readonly io: Server;
  private readonly players = new Map<string, Player>(); // token → player
  private readonly bySlot = new Map<number, Player>();
  private readonly stageSockets = new Set<string>();
  private phase: RoomPhase = 'lobby';
  private gameId: GameId | null = null;
  private game: GameModule | null = null;
  private options: RoomOptions = {
    rotation: false,
    puzzleW: 2,
    puzzleH: 2,
    // The camera rules ARE the game — untick 👁 in the lobby for the
    // classic freeze-on-movement variant (no cameras needed).
    medusaEyes: true,
  };
  private readonly images = new Map<string, Buffer>(); // insertion order = upload order
  private nextSlot = 1;
  private botTicker: ReturnType<typeof setInterval> | null = null;
  private botsCreated = 0;
  lastActivity = Date.now();

  constructor(io: Server, code: string) {
    this.io = io;
    this.code = code;
  }

  private get channel() {
    return `room:${this.code}`;
  }
  private get stageChannel() {
    return `room:${this.code}:stage`;
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  roomState(): RoomState {
    return {
      code: this.code,
      phase: this.phase,
      game: this.gameId,
      players: [...this.bySlot.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => ({
          id: p.slot,
          name: p.name,
          color: p.color,
          connected: p.isBot ? true : p.socketId !== null,
          bot: p.isBot || undefined,
        })),
      options: this.options,
      images: [...this.images.keys()].map((id) => ({ id })),
    };
  }

  getImage(id: string): Buffer | undefined {
    return this.images.get(id);
  }

  // Stage uploads a puzzle picture (base64 jpeg/png, already downscaled
  // client-side). Lobby-only, like the other host controls.
  addArt(socket: Socket, data: unknown, cb?: (res: unknown) => void) {
    const reply = (res: { ok: boolean; id?: string; err?: string }) => {
      if (typeof cb === 'function') cb(res);
    };
    if (!socket.data.stage || this.phase !== 'lobby') {
      reply({ ok: false, err: 'Only the stage can add pictures, in the lobby' });
      return;
    }
    if (typeof data !== 'string' || data.length === 0) {
      reply({ ok: false, err: 'Bad image data' });
      return;
    }
    if (this.images.size >= MAX_ROOM_IMAGES) {
      reply({ ok: false, err: `Limit of ${MAX_ROOM_IMAGES} pictures per room` });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } catch {
      reply({ ok: false, err: 'Bad image data' });
      return;
    }
    if (buf.length === 0 || buf.length > 1_500_000) {
      reply({ ok: false, err: 'Image too large (1.5MB max after downscaling)' });
      return;
    }
    this.touch();
    const id = randomBytes(8).toString('hex');
    this.images.set(id, buf);
    this.broadcastRoom();
    reply({ ok: true, id });
  }

  removeArt(socket: Socket, id: unknown) {
    if (!socket.data.stage || this.phase !== 'lobby') return;
    if (typeof id !== 'string') return;
    if (this.images.delete(id)) {
      this.touch();
      this.broadcastRoom();
    }
  }

  private broadcastRoom() {
    this.io.to(this.channel).emit('room', this.roomState());
  }

  addStage(socket: Socket) {
    this.touch();
    socket.data.code = this.code;
    socket.data.stage = true;
    this.stageSockets.add(socket.id);
    socket.join(this.channel);
    socket.join(this.stageChannel);
    socket.emit('room', this.roomState());
  }

  join(socket: Socket, name: unknown, token: unknown): JoinResponse {
    this.touch();
    let player = typeof token === 'string' ? this.players.get(token) : undefined;
    const isNew = !player;
    if (!player) {
      if (this.players.size >= MAX_PLAYERS) {
        return { ok: false, err: `Room is full (${MAX_PLAYERS} players max)` };
      }
      const slot = this.nextSlot++;
      player = {
        token: randomUUID(),
        slot,
        name: sanitizeName(name, `Player ${slot}`),
        color: colorForSlot(slot),
        socketId: null,
      };
      this.players.set(player.token, player);
      this.bySlot.set(player.slot, player);
    } else {
      player.name = sanitizeName(name, player.name);
    }

    // Detach any previous socket for this player (e.g. duplicate tab).
    if (player.socketId && player.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(player.socketId);
      old?.leave(this.channel);
      if (old) old.data.code = undefined;
    }
    player.socketId = socket.id;
    socket.data.code = this.code;
    socket.data.token = player.token;
    socket.data.stage = false;
    socket.join(this.channel);

    if (isNew) this.game?.onJoin(player.slot);
    this.broadcastRoom();
    this.sendMe(player.slot);
    return {
      ok: true,
      token: player.token,
      playerId: player.slot,
      name: player.name,
      color: player.color,
      room: this.roomState(),
    };
  }

  private meState(slot: number): MeState | null {
    const player = this.bySlot.get(slot);
    if (!player) return null;
    const base: MeState = {
      playerId: player.slot,
      name: player.name,
      color: player.color,
      phase: this.phase,
      game: this.gameId,
    };
    if (this.game) Object.assign(base, this.game.personal(slot));
    return base;
  }

  sendMe(slot: number) {
    const player = this.bySlot.get(slot);
    if (!player?.socketId) return;
    const me = this.meState(slot);
    if (me) this.io.to(player.socketId).emit('me', me);
  }

  private sendMeAll() {
    for (const slot of this.bySlot.keys()) this.sendMe(slot);
  }

  private makeCtx(): GameCtx {
    return {
      slots: () =>
        [...this.bySlot.values()]
          .sort((a, b) => a.slot - b.slot)
          .map((p) => ({ slot: p.slot, name: p.name, color: p.color })),
      options: this.options,
      isBot: (slot: number) => !!this.bySlot.get(slot)?.isBot,
      imageIds: () => [...this.images.keys()],
      emitStage: (snapshot: StageSnapshot) => {
        this.io.to(this.stageChannel).emit('snapshot', snapshot);
      },
      emitMe: (slot: number) => this.sendMe(slot),
      buzz: (slot: number, type: BuzzType) => {
        const player = this.bySlot.get(slot);
        if (player?.socketId) this.io.to(player.socketId).emit('buzz', type);
      },
      send: (slot: number, event: string, data: unknown) => {
        const player = this.bySlot.get(slot);
        if (player?.socketId) this.io.to(player.socketId).emit(event, data);
      },
    };
  }

  private applyOptions(options: unknown) {
    if (!options || typeof options !== 'object') return;
    const o = options as Partial<RoomOptions>;
    if (typeof o.rotation === 'boolean') this.options.rotation = o.rotation;
    if (typeof o.medusaEyes === 'boolean') this.options.medusaEyes = o.medusaEyes;
    const clampDim = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(MAX_PUZZLE_DIM, Math.max(MIN_PUZZLE_DIM, Math.trunc(v)))
        : fallback;
    this.options.puzzleW = clampDim(o.puzzleW, this.options.puzzleW);
    this.options.puzzleH = clampDim(o.puzzleH, this.options.puzzleH);
    // A 1x1 "puzzle" is no puzzle at all.
    if (this.options.puzzleW * this.options.puzzleH < 2) this.options.puzzleH = 2;
  }

  // Host adjusts settings (steppers/checkbox) ahead of the next round; kept
  // server-side so a mid-adjustment room broadcast can't reset them.
  setOptions(socket: Socket, options: unknown) {
    if (!socket.data.stage) return;
    this.touch();
    this.applyOptions(options);
    this.broadcastRoom();
  }

  startGame(socket: Socket, gameId: unknown, options: unknown) {
    if (!socket.data.stage) return;
    if (gameId !== 'los' && gameId !== 'puzzle' && gameId !== 'medusa') return;
    if (this.bySlot.size === 0) return;
    this.touch();
    this.stopGame();
    this.applyOptions(options);
    this.gameId = gameId;
    this.phase = 'playing';
    const ctx = this.makeCtx();
    this.game =
      gameId === 'los'
        ? new LastOneStanding(ctx)
        : gameId === 'puzzle'
          ? new TeamPuzzles(ctx)
          : new Medusa(ctx);
    this.broadcastRoom();
    this.game.start();
    this.startBotTicker();
    this.sendMeAll();
  }

  private startBotTicker() {
    if ([...this.bySlot.values()].every((p) => !p.isBot)) return;
    this.botTicker = setInterval(() => {
      const game = this.game;
      if (!game) return;
      for (const p of this.bySlot.values()) {
        if (!p.isBot) continue;
        const result = game.botInput(p.slot);
        if (!result) continue;
        for (const payload of Array.isArray(result) ? result : [result]) {
          game.input(p.slot, payload);
        }
      }
    }, 180);
  }

  private stopGame() {
    this.game?.dispose();
    this.game = null;
    if (this.botTicker) clearInterval(this.botTicker);
    this.botTicker = null;
  }

  toLobby(socket: Socket) {
    if (!socket.data.stage) return;
    this.touch();
    this.stopGame();
    this.gameId = null;
    this.phase = 'lobby';
    this.broadcastRoom();
    this.sendMeAll();
  }

  // Add (delta > 0) or remove (delta < 0) server-driven fake players.
  adjustBots(socket: Socket, delta: unknown) {
    if (!socket.data.stage || this.phase !== 'lobby') return;
    const d = Math.trunc(typeof delta === 'number' && Number.isFinite(delta) ? delta : 0);
    if (d === 0) return;
    this.touch();
    if (d > 0) {
      const room = MAX_PLAYERS - this.players.size;
      for (let i = 0; i < Math.min(d, room); i++) {
        const slot = this.nextSlot++;
        const base = BOT_NAMES[this.botsCreated % BOT_NAMES.length];
        const suffix = Math.floor(this.botsCreated / BOT_NAMES.length);
        this.botsCreated++;
        const player: Player = {
          token: `bot-${randomUUID()}`,
          slot,
          name: suffix > 0 ? `${base} ${suffix + 1}` : base,
          color: colorForSlot(slot),
          socketId: null,
          isBot: true,
        };
        this.players.set(player.token, player);
        this.bySlot.set(slot, player);
      }
    } else {
      const bots = [...this.bySlot.values()]
        .filter((p) => p.isBot)
        .sort((a, b) => b.slot - a.slot)
        .slice(0, -d);
      for (const bot of bots) {
        this.players.delete(bot.token);
        this.bySlot.delete(bot.slot);
      }
    }
    this.broadcastRoom();
  }

  input(socket: Socket, payload: InputPayload) {
    const token = socket.data.token as string | undefined;
    if (!token) return;
    const player = this.players.get(token);
    if (!player || player.socketId !== socket.id) return;
    this.touch();
    this.game?.input(player.slot, payload);
  }

  onDisconnect(socket: Socket) {
    if (this.stageSockets.delete(socket.id)) return;
    const token = socket.data.token as string | undefined;
    if (!token) return;
    const player = this.players.get(token);
    if (player && player.socketId === socket.id) {
      player.socketId = null;
      this.broadcastRoom();
    }
  }

  isAbandoned(now: number): boolean {
    const anyoneConnected =
      this.stageSockets.size > 0 ||
      [...this.players.values()].some((p) => p.socketId !== null);
    if (anyoneConnected) return false;
    return now - this.lastActivity > 30 * 60 * 1000;
  }

  dispose() {
    this.stopGame();
  }
}
