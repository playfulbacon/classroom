# 🕹️ Classroom Arcade

Multiplayer party games for a whole classroom (up to **70 students**): the
teacher projects the **stage** on the big screen, students scan a QR code and
their phones become full-screen gesture controllers. All game logic runs on an
authoritative Node server — phones only send inputs and the projector renders
everything, so it stays smooth even on school wi-fi.

## The games

### ⚔️ Last One Standing
Everyone is a numbered bumper-car circle on a shrinking arena. Hold & drag
anywhere on your phone to steer (invisible joystick), quick-flick to **dash**.
Bump rivals off the edge, bounce off pinball bumpers, survive the wind gusts,
bumper frenzies and turbo events. Last player on the floor wins.

### 🧩 Team Puzzles
Every player is one piece of a picture. Find the classmates whose pieces
match yours on the big board, navigate the crowd, and snap together into the
full image — first team to assemble wins. Movement feels continuous but
settles onto a grid (Wilmot-style). Optional hard mode: pieces spawn rotated
and a tap rotates your piece.

- **Puzzle size is configurable** from the lobby (width × height in cells,
  1–5 per axis) — team size is width × height, e.g. 3×2 puzzles make teams
  of six.
- **Upload your own pictures** with the 📷 button in the lobby: each photo
  becomes one team's puzzle (center crop-to-filled to the puzzle shape and
  split evenly across the pieces). Teams without a photo get distinctive
  procedural artwork, so every team's picture stays unique. Photos are
  downscaled in the browser before upload and served from room memory at
  `/art/{room}/{id}`.
- **Any class size works**: teams are dealt as evenly as possible
  (`ceil(N / teamSize)` teams, sizes differing by at most one), and short
  teams get pre-locked *phantom* pieces already sitting on the board that
  the team assembles around. If another team ever locks its puzzle on top of
  a phantom's assembly area, the phantoms slide to a fresh spot.

## Quick start

```bash
npm install
npm run dev        # server on :3001, client on :5173
```

Open `http://localhost:5173/stage` for the big screen, and `http://localhost:5173`
on phones (or more browser tabs) to join with the room code.

**Testing with fake players:** the stage lobby has a 🤖 control (`−` / `＋` /
`+10` / `clear`) that adds server-driven bots. They play both games for real —
in Last One Standing they wander, flee the shrinking edge and dash at rivals;
in Team Puzzles they pathfind to their team's assembly spot, and when a group
mixes bots with humans, the bots come and assemble around the real player.
Add and remove them from the lobby between rounds.

For phones on the same network, use the LAN URL Vite prints (e.g.
`http://192.168.x.x:5173`) — the QR code on the stage encodes whatever host the
stage page was opened on.

## Production

```bash
npm install
npm run build      # builds the client into client/dist
npm start          # single server serves the app + websockets on $PORT
```

Deploy to any host that supports long-lived WebSocket processes (Render,
Railway, Fly.io, a VPS). Avoid serverless platforms. One small instance
comfortably handles a full class: the server streams game state to the *stage
only*; phones exchange a few tiny messages per second.

## Tests

```bash
npm run smoke      # white-box puzzle unit tests, then an end-to-end run:
                   # a real server, a stage + 12 simulated phones playing both
                   # games, bots solving a 3x2 puzzle unaided, image
                   # upload/serve round-trip, and an idle-player regression
npm run typecheck
```

## Architecture

```
shared/protocol.ts   message + snapshot types shared by client and server
server/              Node + Express + Socket.IO
  src/room.ts        rooms, join codes, reconnect-to-slot tokens, host controls
  src/games/         one authoritative module per game
    lastOneStanding.ts   30 Hz physics: thrust/drag, collisions, bumpers,
                         shrinking arena, scheduled events
    teamPuzzles.ts       15 Hz grid logic: cell-stepped movement, slide-around
                         blocking, 2x2 snap detection, phantom pieces for
                         uneven class sizes
client/              Vite + React
  src/pages/Stage.tsx    projector: lobby with QR + canvas game rendering
  src/pages/Play.tsx     phone: full-screen gesture surface (drag joystick,
                         flick, tap), wake lock, vibration cues
  src/render/            canvas renderers (interpolation, tweening, confetti)
  src/art.ts             deterministic procedural artwork per puzzle group —
                         only the group id travels over the network
```

Design notes:

- **Server-authoritative** — phones send intents (`joy`, `dash`, `dir`, `rot`),
  the server simulates, the stage renders. Nothing a student can do in dev
  tools beats the referee.
- **One heavy stream, many light ones** — full snapshots go only to the stage
  screen; each phone gets tiny personal events (`me`, `buzz`), which is what
  makes 70 players on classroom wi-fi comfortable.
- **Reconnect-to-slot** — each phone stores a token in `localStorage`; a
  refresh or wi-fi blip puts the student back on their same character.
- **Grid truth, continuous feel** (Team Puzzles) — the server thinks in cells;
  the stage eases sprites between cell centers and leans them into blocked
  moves, so it looks physical but stays latency-proof.
