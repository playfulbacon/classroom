// Shared message + state types for Classroom Arcade.
// Imported by both the server and the client.

export type GameId = 'los' | 'puzzle' | 'medusa';

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
  puzzleW: number; // Team Puzzles: puzzle width in cells (team size = W*H)
  puzzleH: number; // Team Puzzles: puzzle height in cells
}

export interface RoomImageInfo {
  id: string; // fetch at GET /art/{roomCode}/{id}
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  game: GameId | null;
  players: PlayerInfo[];
  options: RoomOptions;
  images: RoomImageInfo[]; // teacher-uploaded puzzle pictures, upload order
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

// Piece position within its puzzle: q in [0, gw*gh), reading order —
// qx = q % gw, qy = floor(q / gw).
export interface PuzzlePieceSnap {
  id: number; // piece id (== owner slot for real pieces; negative for phantoms)
  g: number; // group id, 0-based — also the seed for procedural artwork
  q: number; // cell index within the puzzle (reading order)
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
  gw: number; // puzzle width in cells
  gh: number; // puzzle height in cells
  pieces: PuzzlePieceSnap[];
  groupCount: number;
  // group id → uploaded image id (null = procedural artwork from the group id)
  groupImages: (string | null)[];
  // group ids in finishing order
  finished: number[];
}

// ---------------------------------------------------------------------------
// Medusa (red light, green light)
// ---------------------------------------------------------------------------

export type MedusaGazeState = 'green' | 'turning' | 'red' | 'returning';

// Player states in the snapshot tuple
export const MEDUSA_RUNNING = 0;
export const MEDUSA_STONE = 1;
export const MEDUSA_FINISHED = 2;
export const MEDUSA_FALLEN = 3;

// [slot, col, lane, state] — col 0 = start edge (left), col length-1 = the
// finish column at Medusa's feet (right); lane = depth position on screen.
export type MedusaPlayerTuple = [number, number, number, number];

export interface MedusaSnapshot {
  kind: 'medusa';
  phase: GamePhase;
  countdown: number;
  t: number; // seconds since play began
  timeLimit: number;
  length: number; // columns along the race axis
  lanes: number;
  pits: [number, number][]; // [col, lane]
  gaze: {
    state: MedusaGazeState;
    tLeft: number; // seconds remaining in this gaze state
  };
  players: MedusaPlayerTuple[];
  // slots that pinged "find me" since the previous snapshot (beacon cue)
  pings: number[];
  finished: number[]; // slots in finishing order
  aliveCount: number;
}

export type StageSnapshot = LosSnapshot | PuzzleSnapshot | MedusaSnapshot;

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
  quadrant?: number; // this piece's q index within the puzzle
  gw?: number;
  gh?: number;
  imageId?: string | null; // uploaded picture for this team, null = procedural
  rotationEnabled?: boolean;
  teamRank?: number; // 1-based finish position once the team locks
  // Medusa
  medusaState?: 'running' | 'stone' | 'finished' | 'fallen';
  col?: number; // current progress column
  fieldLength?: number;
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
  | { t: 'touch'; down: boolean } // Puzzle: finger on/off (drives glow)
  | { t: 'hop'; d: 'f' | 'l' | 'r' | 'b' } // Medusa: hop forward/left/right/back
  | { t: 'ping' }; // Medusa: cosmetic "find me" beacon (always safe)

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
//  'host:art:add'    ({data: base64 jpeg/png}, cb {ok, id?, err?}) — stage only
//  'host:art:remove' ({id: string}) — stage only
//  'input'        (InputPayload)

export const MAX_PLAYERS = 100;
export const MIN_PUZZLE_DIM = 1;
export const MAX_PUZZLE_DIM = 5;
export const MAX_ROOM_IMAGES = 20;

export function colorForSlot(slot: number): string {
  const hue = (slot * 137.508) % 360;
  const light = 52 + ((slot * 7) % 3) * 6; // 52/58/64 — varies neighbors a bit
  return `hsl(${hue.toFixed(1)} 85% ${light}%)`;
}
