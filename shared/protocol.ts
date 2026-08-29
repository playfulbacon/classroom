// Shared message + state types for Classroom Arcade.
// Imported by both the server and the client.

export type GameId = 'los' | 'puzzle';

export type RoomPhase = 'lobby' | 'playing';

export interface PlayerInfo {
  id: number; // stable 1-based slot, doubles as the on-screen number
  name: string;
  color: string;
  connected: boolean;
  bot?: boolean; // server-driven fake player for testing
}

export interface RoomOptions {
  rotation: boolean; // Team Puzzles: require correct piece orientation
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  game: GameId | null;
  players: PlayerInfo[];
  options: RoomOptions;
}

// ---------------------------------------------------------------------------
// Last One Standing
// ---------------------------------------------------------------------------

export type GamePhase = 'countdown' | 'play' | 'over';

export interface LosObstacle {
  x: number;
  y: number;
  r: number;
}

// [slot, x, y, alive] — positions in world units, arena centered at (0,0)
export type LosPlayerTuple = [number, number, number, 0 | 1];

export type LosEventKind = 'wind' | 'bumpers' | 'frenzy';

export interface LosEvent {
  kind: LosEventKind;
  // wind only: unit direction of the push
  dx?: number;
  dy?: number;
  // seconds until the event begins (warning phase) — 0 once active
  warn: number;
  // seconds of active effect remaining
  tLeft: number;
}

export interface LosSnapshot {
  kind: 'los';
  phase: GamePhase;
  countdown: number;
  arenaR: number;
  players: LosPlayerTuple[];
  obstacles: LosObstacle[];
  event: LosEvent | null;
  aliveCount: number;
  // filled when phase === 'over': slots in finishing order, winner first
  placements: number[];
}

// ---------------------------------------------------------------------------
// Team Puzzles
// ---------------------------------------------------------------------------

// Quadrants: 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right
export interface PuzzlePieceSnap {
  id: number; // piece id (== owner slot for real pieces; negative for phantoms)
  g: number; // group id, 0-based — also the seed for the group's artwork
  q: number; // quadrant 0..3
  cx: number; // grid cell x
  cy: number; // grid cell y
  rot: number; // 0..3 quarter turns
  locked: boolean;
  active: boolean; // owner is currently touching their screen
  nx: number; // last blocked-move nudge direction (0 when none)
  ny: number;
}

export interface PuzzleSnapshot {
  kind: 'puzzle';
  phase: GamePhase;
  countdown: number;
  cols: number;
  rows: number;
  pieces: PuzzlePieceSnap[];
  groupCount: number;
  // group ids in finishing order
  finished: number[];
}

export type StageSnapshot = LosSnapshot | PuzzleSnapshot;

// ---------------------------------------------------------------------------
// Personal state pushed to each phone ('me' event)
// ---------------------------------------------------------------------------

export interface MeState {
  playerId: number;
  name: string;
  color: string;
  phase: RoomPhase;
  game: GameId | null;
  waiting?: boolean; // joined while a round was already running
  // Last One Standing
  alive?: boolean;
  placement?: number; // final rank, 1 = winner
  // Team Puzzles
  group?: number;
  quadrant?: number;
  rotationEnabled?: boolean;
  teamRank?: number; // 1-based finish position once the team locks
}

export type BuzzType = 'bumped' | 'eliminated' | 'locked' | 'go';

// ---------------------------------------------------------------------------
// Socket event payloads
// ---------------------------------------------------------------------------

export interface JoinRequest {
  code: string;
  name?: string;
  token?: string; // reconnect token from a previous join
}

export interface JoinResponse {
  ok: boolean;
  err?: string;
  token?: string;
  playerId?: number;
  name?: string;
  color?: string;
  room?: RoomState;
}

export interface StageAttachResponse {
  ok: boolean;
  room?: RoomState;
}

export type InputPayload =
  | { t: 'joy'; x: number; y: number } // LOS: held joystick vector, |v| <= 1
  | { t: 'dash'; x: number; y: number } // LOS: flick dash, unit direction
  | { t: 'dir'; x: number; y: number } // Puzzle: held movement vector
  | { t: 'rot' } // Puzzle: tap to rotate
  | { t: 'touch'; down: boolean }; // Puzzle: finger on/off (drives glow)

export interface HostStartRequest {
  game: GameId;
  options?: Partial<RoomOptions>;
}

// Server → client event names (for reference):
//  'room'     RoomState        — everyone in the room
//  'snapshot' StageSnapshot    — stage screens only
//  'me'       MeState          — one phone
//  'buzz'     BuzzType         — one phone (vibration cue)
// Client → server:
//  'stage:create' (cb: {code, room})
//  'stage:attach' ({code}, cb: StageAttachResponse)
//  'join'         (JoinRequest, cb: JoinResponse)
//  'host:start'   (HostStartRequest)
//  'host:lobby'   ()
//  'host:bots'    ({delta: number}) — add/remove fake players (lobby only)
//  'input'        (InputPayload)

export const MAX_PLAYERS = 70;

export function colorForSlot(slot: number): string {
  const hue = (slot * 137.508) % 360;
  const light = 52 + ((slot * 7) % 3) * 6; // 52/58/64 — varies neighbors a bit
  return `hsl(${hue.toFixed(1)} 85% ${light}%)`;
}
