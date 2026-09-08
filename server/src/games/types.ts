import type {
  BuzzType,
  GameId,
  InputPayload,
  MeState,
  RoomOptions,
  StageSnapshot,
} from '../../../shared/protocol';

export interface SlotInfo {
  slot: number;
  name: string;
  color: string;
}

// What a game module gets from the room to talk to the world.
export interface GameCtx {
  slots(): SlotInfo[];
  options: RoomOptions;
  isBot(slot: number): boolean;
  imageIds(): string[]; // teacher-uploaded pictures, upload order
  emitStage(snapshot: StageSnapshot): void;
  emitMe(slot: number): void; // room re-sends 'me' built from game.personal()
  buzz(slot: number, type: BuzzType): void;
  // game-specific event straight to one phone (e.g. Medusa 'pulse')
  send(slot: number, event: string, data: unknown): void;
}

export interface GameModule {
  readonly id: GameId;
  start(): void;
  // Stage signal: the narrated intro finished — begin the countdown.
  // Only games with an 'intro' phase implement it.
  introDone?(): void;
  dispose(): void;
  input(slot: number, payload: InputPayload): void;
  // called when a new player joins mid-round
  onJoin(slot: number): void;
  // game-specific fields merged into the player's MeState
  personal(slot: number): Partial<MeState>;
  // AI move(s) for a fake player; the room feeds each result back into
  // input(), so bots exercise the exact same code path phones do
  botInput(slot: number): InputPayload | InputPayload[] | null;
}
