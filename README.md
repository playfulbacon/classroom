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
obstacle-riddled field; swipe to dodge (or hop back). **Pits are always
deadly** — hop into one and it swallows you (🕳 fallen, out of the
round), whatever the light and whatever your eyes are doing; only the
field edge just bounces:

- **Chasms** span the whole field and are crossed on **ferry platforms**
  that shuttle between the banks — board only when one is actually
  docked (hop early and it's open water), ride it across (petrified
  passengers keep ferrying forever), hop off on the far side.
- **Crumbling ground** — exactly three cells, spaced evenly along each
  ground segment between the chasms. They crack underfoot and collapse
  into a single pit shortly after you leave — a fresh hole for whoever
  was following. Fields start with no single pits at all; every single
  pit on the field is the scar of someone's crossing.

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

**👁 Eye mode** (default on — a lobby checkbox drops back to classic):
the real Medusa rules — it's about whether your **eyes are open**, never
whether you move. When she turns, the projector **cuts to her face,
fullscreen**, and there is exactly one safe state, verified by the front
camera: **close your eyes** and keep running blind — and since pits are
always deadly, every blind hop is a bet on your memory of the route.
Getting caught with your eyes open is nearly fatal: it fills
your per-player **gaze meter** in ~0.5s; hiding from the camera fills it
slowly (~2.5s) — never an advantage, just a slower death. Your phone
buzzes hard when she starts to turn (**shut your eyes**) and buzzes again
when she looks away (**open, run**), so you never need the screen during
red. Stone **creeps up you in tiers** that
slow your hops before it claims you, only provably-open frames raise
them, and tiers decay during green — redemption is possible. Her gaze is
a **sweeping cone**, and statues block it: survivors hide behind the
petrified, so every death is cover for the living. The phone screams
your state at you the whole round: a **full-screen color wash** (green
run / teal safe / red seen / amber can't-see-you), giant banners ("EYES
CLOSED — GO!", "SHE SEES YOU — CLOSE YOUR EYES!"), a fat death-meter
bar, vibration ramps as the stone climbs, and the hall hears the hissing
get louder. While waiting in the lobby the phone runs an **eye
playground** — a safe sandbox showing exactly what the sensor sees, with
a demo meter and a mock petrify, so every player trusts the blink
detection before the round starts.

**Camera access is part of joining**: the mobile join flow gates on the
front camera — nobody enters the room until it's granted (the gate
explains why and retries on failure). Detection runs entirely on the
phone (MediaPipe face landmarks, blink only); **video never leaves the
device** — only a tiny open/closed state code goes to the server. Note:
browsers only expose the camera on **HTTPS or localhost**, so joining
needs a deployed (or tunneled) HTTPS URL when phones join over LAN.

Starting Medusa starts a **series of rounds**. The first round opens
with a **narrated intro**: the rules appear over the visible field
while a generated voice reads them ("Tap and swipe on your phone to
race to the finish line… close your eyes or you'll turn to stone!"), a
beat of silence, then the voice counts down "3, 2, 1, GO!". A round
ends when every player has finished or been eliminated (or time runs
out); finishers earn **10, 8, 6, … points** by placement, the stage
shows the **series leaderboard**, and the next round starts itself 3
seconds later — no intro, straight to the spoken countdown. The teacher
ends the series from the Lobby button.

### 🧱 Human Tetris
A co-op crowd game on the same 3D stage as Medusa, with the same avatars.
Everyone roams one field with a free joystick (swipe anywhere on the phone
and hold). A **shape's outline appears** on the ground and a timer runs; at
zero the **wall — the whole field except the shape — drops out of the sky**
and flattens anyone still outside. It rests while the crushed are counted,
lifts back out of frame, and the next shape appears with a shorter timer.
Shapes are random blobs that usually contain **sealed holes** — and often
several, spread across a roomier "swiss" shape — so every round the crowd
has to scatter around gaps and pack into corridors. The shape always has
**at least one cell per person and per NPC**, plus breathing room that
shrinks to a single spare cell by round nine.

- **One per cell.** A cell holds exactly one occupant — a player (with or
  without a rider) or a waiting NPC. Walk into an occupied cell and you
  **barge** whoever is there aside: sideways if there's room, otherwise
  the whole line ahead gets shunted forward (and if it runs into the field
  edge, nobody moves). A freshly barged player can't barge back for a
  beat, so the aggressor keeps the cell. Nobody's crowd can squeeze you
  out; only a deliberate shove can.
- **Lost NPCs** turn up outside the safe zone from round 2 (the little
  ones with the pointed hats, waving "HELP!") — **more every round**. Walk
  into one to scoop it onto your shoulders — **one per player** — carry
  it inside, and **tap to set it down** in the cell ahead of you (a cell
  inside the shape wins over the facing direction). A placed NPC takes a
  cell of its own, so the crowd has to plan around it; then go back for the
  next. A rescued NPC celebrates and vanishes; one left outside is crushed,
  and a rider goes down with a flattened carrier.
- **Lose condition**: flattened players and crushed NPCs both count toward
  a **loss budget** (about a third of the crowd, shown as hearts). Reach it
  and the wall wins; the score is rounds cleared. Flattened players stay out
  for the rest of the game.
- **Phones shout your state**: the whole screen floods green *SAFE* or red
  *OUTSIDE — get in!* with the countdown huge in the middle (a 5 Hz personal
  pulse), buzzes when you're still outside with three seconds to go (and
  when someone barges you), and shows when you're carrying someone.
  **Tap** with empty hands to make your character jump and its number
  flash on the big screen ("find me").
- Late joiners drop in inside the current shape, so a mid-round arrival is
  never an instant flattening.

## Quick start

```bash
npm install
npm run dev        # server on :3001, client on :5173
```

Open `http://localhost:5173/stage` for the big screen, and `http://localhost:5173`
on phones (or more browser tabs) to join with the room code.

**Testing with fake players:** the stage lobby has a 🤖 control (`−` / `＋` /
`+10` / `clear`) that adds server-driven bots. They play all four games for
real — in Last One Standing they wander, flee the shrinking edge and dash at
rivals; in Team Puzzles they pathfind to their team's assembly spot, and when
a group mixes bots with humans, the bots come and assemble around the real
player; in Medusa they pathfind around the obstacles, wait for and ride the
ferries, freeze on red in classic mode, and in eye mode simulate gaze
discipline — some close their eyes and run blind (and the gamblers among
them occasionally drift off the route and fall into a pit), some get
caught staring, a few "have no camera" and meet the slow death; in Human
Tetris they head for free interior cells of the shape with human reaction
lag, a streak of laziness, and a taste for fetching NPCs when there's time
(setting them down inside and going back for more). Add
and remove them from the lobby between rounds.

For phones on the same network, use the LAN URL Vite prints (e.g.
`http://192.168.x.x:5173`) — the QR code on the stage encodes whatever host the
stage page was opened on.

**Eye mode over LAN needs HTTPS** (browsers only expose the camera to secure
pages — plain-http LAN pages get "no mediaDevices API" no matter what you
allow). Run:

```bash
npm run dev:tunnel  # dev servers + a free Cloudflare quick tunnel
```

and open the stage at the printed `https://….trycloudflare.com/stage` URL —
the QR then hands phones a real https link with a valid certificate, so
cameras just work with no warnings (needs internet access).

Fully offline alternative: `npm run dev:https` serves the LAN with a
self-signed certificate — open `https://<your-lan-ip>:5173/stage` and each
phone accepts the certificate warning once. (`localhost` on the laptop itself
always works with plain `npm run dev`.) In production, deploy behind any
HTTPS host and none of this applies.

## Production (the simple way to make cameras "just work")

Phone cameras require an https page, so the intended setup is: host the game
once, get one permanent https URL, and never touch tunnels or certificates
again. This repo ships a Render blueprint:

1. Push the repo to GitHub, go to [render.com](https://render.com) → **New +
   → Blueprint** → pick this repo → Apply.
2. You get `https://classroom-arcade-<something>.onrender.com`. Bookmark
   `/stage` on the classroom machine — that's the whole workflow from then on:
   open stage, students scan, cameras prompt normally.
3. Every push to `main` redeploys automatically (~2 min), so iterating with
   real phones is just: push, wait for deploy, reload the same bookmark. The
   🐞 panel's build hash shows when the new version is live.

(Free tier note: the instance sleeps when idle — the first visit of the day
takes ~30s to wake.)

Any other host with long-lived WebSocket processes works the same way
(Railway, Fly.io, a VPS behind Caddy):

```bash
npm install
npm run build      # builds the client into client/dist
npm start          # single server serves the app + websockets on $PORT
```

Avoid serverless platforms. One small instance comfortably handles a full
class: the server streams game state to the *stage only*; phones exchange a
few tiny messages per second.

## Tests

```bash
npm run smoke      # white-box unit tests (puzzle + medusa rules, eye mode,
                   # tetris shapes + round rules), then an end-to-end run: a
                   # real server, a stage + 12 simulated phones playing all
                   # four games (including an eye-mode medusa round and a
                   # human tetris rescue), bots solving a 3x2 puzzle, a
                   # medusa field and a tetris crowd unaided, image
                   # upload/serve round-trip, and an idle-player regression
npm run typecheck
npm run screenshot # after `npm run build`: opens the stage in a headless
                   # browser and saves lobby + every game to ./screenshots
```

The screenshot script uses `playwright-core`, which deliberately ships no
browsers so `npm install` stays quick. It drives the Chrome or Edge already on
your machine; set `CHROMIUM_PATH` to point at a different Chromium build.

## Day-to-day editing

`npm run dev` watches for changes: edit anything under `client/src` and the
browser updates in place; edit `server/src` or `shared/` and the server
restarts itself (players will need to rejoin). The same applies to
`git pull` while dev is running — new code hot-loads into open pages. You
only need `npm install` + a dev-server restart when `package.json` or
`vite.config.ts` changed.

Phones have a 🐞 button (top-left, on every player screen): it toggles a live
diagnostics panel — build hash first (so a stale checkout is obvious), then
camera pipeline state, per-frame gaze-detection internals, what's being sent,
and the server's verdict on you (meter/tier/effective state) during Medusa.

## Architecture

```
shared/protocol.ts   message + snapshot types shared by client and server
shared/iso.ts        the 3D games' camera directions and the screen ↔ ground
                     joystick mapping, so phone swipes and the stage camera
                     can never disagree
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
                         stone tiers, per-phone pulse stream)
    medusaField.ts       field generation with explicit BFS solvability:
                         carved safe paths, chasm bands, ferries, crumble
    humanTetris.ts       20 Hz free movement on an exclusive cell grid
                         (barging, chains, stun), the form/drop/rest/rise
                         round machine, NPC carrying + placing, loss
                         budget, bots
    tetrisShapes.ts      random 4-connected shapes with sealed interior
                         holes (blob + multi-hole swiss families), sized
                         for the crowd and kept off the edge
client/              Vite + React
  src/pages/Stage.tsx    projector: lobby with QR + canvas game rendering
  src/pages/Play.tsx     phone: full-screen gesture surface (drag joystick,
                         flick, tap), wake lock, vibration cues
  src/render/            canvas renderers (interpolation, tweening, confetti)
    avatar.ts            the shared 3D player avatar (capsule + head + shadow,
                         lights, colour helpers) used by every 3D game —
                         upgrade it once and every crowd gets it
    medusa3d.ts + medusaScene.ts   Medusa stage (head, cameras, field art)
    tetris3d.ts          Human Tetris stage: shape outline, the instanced
                         wall's hover/drop/rest/rise, NPCs riding on
                         shoulders, HUD
  src/art.ts             deterministic procedural artwork per puzzle group —
                         only the group id travels over the network
  src/gaze.ts            lazy-loaded on-device blink detection (MediaPipe
                         face landmarks) for Medusa eye mode — emits only a
                         tiny open/closed code, video stays on the phone
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
