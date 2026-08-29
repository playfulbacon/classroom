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
  emitStage(snapshot: StageSnapshot): void;
  emitMe(slot: number): void; // room re-sends 'me' built from game.personal()
  buzz(slot: number, type: BuzzType): void;
}

export interface GameModule {
  readonly id: GameId;
  start(): void;
  dispose(): void;
  input(slot: number, payload: InputPayload): void;
  // called when a new player joins mid-round
  onJoin(slot: number): void;
  // game-specific fields merged into the player's MeState
  personal(slot: number): Partial<MeState>;
  // AI move for a fake player; the room feeds the result back into input()
  botInput(slot: number): InputPayload | null;
}
