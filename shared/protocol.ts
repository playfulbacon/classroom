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
  // Medusa: front-camera eye mode — looking at her during red petrifies you,
  // but eyes-closed players may keep moving (on-device detection only).
  medusaEyes: boolean;
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

// 'intro' precedes the countdown where a game wants a narrated setup (only
// Medusa uses it: the stage shows/speaks the rules over the visible field,
// then signals 'host:intro-done' to begin the countdown).
export type GamePhase = 'intro' | 'countdown' | 'play' | 'over';

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

// Player states in the snapshot tuple. Pits are ALWAYS deadly: any hop
// into an open pit, chasm water (no aligned ferry), or collapsed ground
// swallows the runner (MEDUSA_FALLEN) — sighted or blind, red or green,
// classic or eye mode. Only the field edge merely bounces. Running blind
// at full speed is the gamble; the ground doesn't care about your eyes.
export const MEDUSA_RUNNING = 0;
export const MEDUSA_STONE = 1;
export const MEDUSA_FINISHED = 2;
export const MEDUSA_FALLEN = 3;

// Gaze-state codes (phone → server report, and the gz element in the player
// tuple). The rule is pure open/closed: during red, CLOSED eyes are the one
// safe state; OPEN eyes fill the death meter fast, UNKNOWN (no face /
// camera covered / stale) fills it slowly — hiding from the camera is never
// safety, just a slower death.
export const GZ_CLOSED = 1; // eyes closed (may keep moving, blind)
export const GZ_OPEN = 2; // eyes open — her gaze meets yours during red
export const GZ_UNKNOWN = 3; // tracking lost / covered / never reported
export const GZ_CLASSIC = -1; // room runs classic rules (eye mode off)

// [slot, col, lane, state, gz, meterQ, tier] — col 0 = start edge (left),
// col length-1 = the finish at Medusa's feet (right); lane = depth position;
// gz = GZ_* (always CLASSIC when eye mode is off); meterQ = death meter
// 0..100; tier = stone tier 0..2 (petrified IS tier 3, carried by state).
export type MedusaPlayerTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

// A ferry platform shuttling across a chasm band: [id, lane, c0, c1, pos].
// It occupies cell (round(pos), lane) and bounces between columns c0 and c1;
// runners hop on when it's aligned with an edge cell and ride it across.
export type MedusaPlatformTuple = [number, number, number, number, number];

// Crumbling ground: [col, lane, stage] — 0 intact (hairline cracks), 1 cracked
// (someone stepped on it), 2 gone (collapsed into a blocking pit).
export type MedusaCrumbleTuple = [number, number, 0 | 1 | 2];

export interface MedusaSnapshot {
  kind: 'medusa';
  phase: GamePhase;
  // During 'countdown' the 3-2-1; during 'over' the seconds until the next
  // round of the series starts itself.
  countdown: number;
  round: number; // 1-based round number within the series
  // Series leaderboard, sorted by points desc: [slot, totalPoints]. Finish
  // placements earn 10, 8, 6, … points per round.
  scores: [number, number][];
  t: number; // seconds since play began
  timeLimit: number;
  length: number; // columns along the race axis
  lanes: number;
  pits: [number, number][]; // [col, lane] — includes chasm band cells
  platforms: MedusaPlatformTuple[];
  crumble: MedusaCrumbleTuple[];
  eyesMode: boolean; // v2 camera rules are live this round
  gaze: {
    state: MedusaGazeState;
    tLeft: number; // seconds remaining in this gaze state
    dir: number; // sweep angle (radians off the field axis, 0 = center)
    target: number; // slot her eyes swivel toward (highest meter), 0 = none
  };
  players: MedusaPlayerTuple[];
  // slots that pinged "find me" since the previous snapshot (beacon cue)
  pings: number[];
  finished: number[]; // slots in finishing order
  aliveCount: number;
}

// Personal state pulse ('pulse' event): sent ~5Hz to each running player
// through an eye-mode round. Feeds the phone's full-screen state feedback —
// the player must always know exactly what the game thinks their eyes are
// doing and how far the stone has crept.
export interface MedusaPulseMsg {
  g: [number, number]; // [gaze phase 0 green/1 turning/2 red/3 returning, tLeft]
  me: [number, number, number, number, number]; // [col, lane, meterQ, tier, gz]
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
  eyeMode?: boolean; // room has eye mode on — the phone should arm its camera
  tier?: number; // stone tier 0..2 (how far the stone has crept)
}

export type BuzzType =
  | 'bumped'
  | 'eliminated'
  | 'locked'
  | 'go'
  | 'creep'
  | 'warn' // Medusa is about to turn toward the field — shut your eyes
  | 'clear'; // she's turned away — eyes open, all clear

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
  | { t: 'ping' } // Medusa: cosmetic "find me" beacon (always safe)
  // Medusa eye mode: on-device eyes-open detection — a GZ_* state code plus
  // a 0..1 confidence. Sent on change plus a ~250ms heartbeat.
  | { t: 'gaze'; s: 1 | 2 | 3; c: number };

export interface HostStartRequest {
  game: GameId;
  options?: Partial<RoomOptions>;
}

// Server → client event names (for reference):
//  'room'     RoomState        — everyone in the room
//  'snapshot' StageSnapshot    — stage screens only
//  'me'       MeState          — one phone
//  'buzz'     BuzzType         — one phone (vibration cue)
//  'pulse'    MedusaPulseMsg   — one phone, ~5Hz through an eye-mode round
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
