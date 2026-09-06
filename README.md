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

### 🐍 Medusa
Red light, green light — with Crossy Road controls, rendered in real 3D on
the big screen. Tap to hop toward Medusa at the far end of an
obstacle-riddled field; swipe to dodge (or hop back). **Nothing on the
field is deadly** — petrification is the only way out of the round:

- **Pits** block your hop; you just bounce off them.
- **Chasms** span the whole field and are crossed on **ferry platforms**
  that shuttle between the banks — hop aboard when one docks, ride it
  across (petrified passengers keep ferrying forever), hop off on the far
  side.
- **Crumbling ground** cracks underfoot and collapses into a blocking pit
  shortly after you leave it — rough on whoever was following you.

In classic mode (no cameras), any hop while she watches turns you to
stone where you stand — a grace window forgives taps already in flight on
slow wi-fi. Reach her pedestal before the 90-second timer runs out; at
time-up her final gaze petrifies everyone still on the field. Long-press
your phone to make your runner beacon on the big screen ("find me"). The
stage uses an isometric three.js scene (code-split — only the stage
downloads it, only when a Medusa round starts) with a dynamic camera,
plus synthesized sound cues. Drop a `medusa.glb` into
`client/public/models/` to replace the built-in procedural head (see the
README there).

**👁 Eye mode** (lobby checkbox): the real Medusa rules — it's about
where you *look*, never whether you move. When she turns, the projector
**cuts to her face, fullscreen**: the field vanishes from the big screen
and each phone becomes a **mirrored bronze shield** — a dim, warped
reflection of a couple of hops around you, forward up and left/right
flipped (the image is mirrored, your swipes aren't). You have exactly two
safe states, verified by the front camera: **look at your phone** (move
slowly by the shield) or **close your eyes** (move at full speed, blind —
memorize the route). Getting caught looking up fills a per-player **gaze
meter** (~1s to stone); hiding from the camera fills it slowly (~2.5s) —
never an advantage, just a slower death. Stone **creeps up you in tiers**
that slow your hops before it claims you, only provably-caught frames
raise them, and tiers decay during green — redemption is possible. Her
gaze is a **sweeping cone**, and statues block it: survivors hide behind
the petrified, so every death is cover for the living. All the feedback
is diegetic — the shield's rim glows when you're safe, snakes coil around
it as the meter rises, cracks spread when tracking drops, your phone buzzes
as the stone climbs, and the hall hears the hissing get louder.

Detection runs entirely on the phone (MediaPipe face landmarks + head
pose, with a quick "look at your phone" calibration); **video never
leaves the device** — only a tiny safe/caught state goes to the server.
Players get a one-tap consent card first. Note: browsers only expose the
camera on **HTTPS or localhost**, so eye mode needs a deployed (or
tunneled) HTTPS URL when phones join over LAN.

## Quick start

```bash
npm install
npm run dev        # server on :3001, client on :5173
```

Open `http://localhost:5173/stage` for the big screen, and `http://localhost:5173`
on phones (or more browser tabs) to join with the room code.

**Testing with fake players:** the stage lobby has a 🤖 control (`−` / `＋` /
`+10` / `clear`) that adds server-driven bots. They play all three games for
real — in Last One Standing they wander, flee the shrinking edge and dash at
rivals; in Team Puzzles they pathfind to their team's assembly spot, and when
a group mixes bots with humans, the bots come and assemble around the real
player; in Medusa they pathfind around the obstacles, wait for and ride the
ferries, freeze on red in classic mode, and in eye mode simulate gaze
discipline — some close their eyes and run blind, some get caught staring,
a few "have no camera" and meet the slow death. Add and remove them from
the lobby between rounds.

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
npm run smoke      # white-box unit tests (puzzle + medusa rules, eye mode),
                   # then an end-to-end run: a real server, a stage + 12
                   # simulated phones playing all three games (including an
                   # eye-mode medusa round), bots solving a 3x2 puzzle and a
                   # medusa field unaided, image upload/serve round-trip,
                   # and an idle-player regression
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
    medusa.ts            red-light-green-light: gaze state machine, blocking
                         obstacles + ferry riding + crumble lifecycle, and the
                         eye-mode gaze meter (sweeping cone, statue shadows,
                         stone tiers, per-phone shield stream)
    medusaField.ts       field generation with explicit BFS solvability:
                         carved safe paths, chasm bands, ferries, crumble
client/              Vite + React
  src/pages/Stage.tsx    projector: lobby with QR + canvas game rendering
  src/pages/Play.tsx     phone: full-screen gesture surface (drag joystick,
                         flick, tap), wake lock, vibration cues
  src/render/            canvas renderers (interpolation, tweening, confetti)
  src/art.ts             deterministic procedural artwork per puzzle group —
                         only the group id travels over the network
  src/gaze.ts            lazy-loaded on-device gaze classification (MediaPipe
                         face landmarks + head pose) for Medusa eye mode —
                         emits only a tiny state code, video stays on the phone
  src/render/shield.ts   the phone's mirrored bronze shield view (2D canvas —
                         phones never load three.js)
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
