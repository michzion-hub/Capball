# CAPBALL

Bottle-cap street football in the browser. Two players share one device and flick caps into a ball. Built with TypeScript, Vite, HTML Canvas and Matter.js.

```bash
npm install
npm run dev       # http://localhost:3000
npm test          # unit tests (vitest, headless Matter.js)
npm run build     # tsc --noEmit + Vite build → dist/ (self-contained, includes service worker)
npm run smoke     # browser end-to-end test (needs dist/; real mouse + touch flicks)
```

Use Node.js 20.19+ or 22.12+. The game assets are local files under `public/`; the build does not download or restore assets.

## Where to tune things

| File | What lives there |
| --- | --- |
| `src/config/tuning.ts` | **All physics and feel numbers.** Fixed timestep (240 Hz), flick power and power cap, minimum drag, settle thresholds, cap types (radius, density, restitution, grip, power), ball, surfaces (friction scale, board bounce, slope vector, dust), FX (shake, replay length and speed). |
| `src/config/rulesets.ts` | **Rules.** Each ruleset is a plain object: goals to win, timed halves, corners, free kicks, penalties, offside, board bonus, combo length and power multiplier, cap types on/off, spin on/off, stuck-ball turns. The presets are `basic`, `street` (default), `proper` and `arcade`. The setup screen can switch individual flags on top of any preset. |

### Live tuning overlay

Menu → **Tuning tools on**, then **Tune** in the match HUD (or press `` ` `` on desktop). Sliders edit the same objects that `tuning.ts` exports, so every change applies on the next flick. They cover flick strength and curve, drag lengths, spin and curl, settle time, the current surface's friction, board bounce and slope, the ball, and each cap type's grip, bounce, power and weight. Material changes are pushed onto existing bodies with `PhysicsWorld.retune()`. The panel measures every flick: launch speed, slide distance, offset from the launch line, ball travel, hardest hit and time to settle. **Vectors** draws velocity arrows with speed, spin arcs, the last play's cap and ball traces against the straight launch line, and impact strengths. Nothing persists: **Export** lists your changes (`id: old → new`) so you can copy them into `tuning.ts`, and **Reset** restores the file values. On desktop the panel docks on the right; on phones it is a bottom sheet. The pitch re-fits around it either way.

### Spin

Grabbing a cap off-centre puts spin on it, and the spin curls its path. Grab right of the line you're flicking along and the cap spins anticlockwise and bends left. It always curls the way it visibly spins. The aim arrow bends and a cyan arc shows the spin. Grabs near the centre (`INPUT.spinDeadzone`) stay dead straight. In physics terms, curl rotates the velocity vector each step by `PHYSICS.curl × angularVelocity × dt`, so speed and friction are untouched. Spin decays at `PHYSICS.spinFriction`, and a spinning cap passes `PHYSICS.spinTransfer` of its spin to the ball on contact. The `basic` ruleset turns spin off, and setup has a **Spin flicks** toggle.

### Stuck ball

A ball wedged in a corner, or pinned against the boards by a cap, that hasn't moved for `ruleset.deadBallTurns` plays (default 2) gets a whistle. The ref drops it about 80 units toward the centre and moves every cap clear of the drop spot (`DEADBALL` in `tuning.ts`). The next flick goes to whoever was due anyway.

### Corners and goal kicks

With corners on, the ball is out only when it hits the end board at least as hard as `ruleset.outMinImpact` (default 2). Who gives it away is set by `ruleset.outBy`. The default, `'flick'`, means the team whose flick sent the ball out loses it, and deflections don't count: send it into the opponents' end and they get a goal kick; send it into your own end and they get a corner. Proper Football uses `'lastTouch'`, the real-football rule. When the ball goes out the ref whistles, marks the spot with a chalk X, and the caption states the call. Softer rolls bounce back into play like any other board. The threshold is also on the tuning overlay under *Rules*. In a corner (`cornerSetup` in `game/setpieces.ts`), the winger stands behind the ball at the flag, aimed at the penalty spot. The striker and two defenders go to the far post, near post and edge of the box, and the keeper stays home. The defending keeper takes the line, the two defenders take the near post and goal side, the winger goes to the edge of the box, and the striker waits on halfway. Every defender stays at least the wall distance from the ball, and no caps overlap.

### Friction

Friction is applied **once**. Matter's own `frictionAir` and `friction` are 0, and `physics/world.ts` applies a single Coulomb-style sliding friction each fixed step (constant deceleration = `grip × surface.frictionScale`). Bodies slow down and stop crisply, with no long exponential creep. The same per-step hook adds the slope acceleration on The Hill. Nothing moves a fixed distance during play; positions are only written between plays (kickoffs and set pieces).

## Architecture

```
src/
  config/      tuning.ts, rulesets.ts   ← the only places with magic numbers / rules
  physics/     world.ts (Matter world, bodies, flick impulse, friction, contacts), settle.ts (pure)
  game/        match.ts (orchestrator), turns.ts (state machine), rules.ts (goal latch, scoring),
               play.ts (per-play tracker: fouls, offside, corners, board bonus, pass chains),
               setpieces.ts, formation.ts, deadball.ts, shootout.ts, tournament.ts, replay.ts, emitter.ts
  input/       flick.ts (pointer events, drag-back aim + off-centre spin, single attach/detach)
  debug/       tunables.ts (live parameter catalog + export/reset, pure), overlay.ts (tuning panel + debug drawing)
  render/      renderer.ts, surfaces.ts (procedural pitches), capArt.ts (caps + sprite cache), view.ts
  fx/          effects.ts (pooled particles, screen shake)
  audio/       audio.ts (synth SFX scaled by impact force), crowd.ts, commentary.ts (captions + optional voice)
  ui/          ui.ts (DOM screens/HUD/modals), setup.ts, editor.ts
  store/       settings.ts (localStorage, sanitised field by field)
  app.ts       wires everything; main.ts boots; pwa.ts registers the service worker
```

`Match` is DOM-free and runs headless in tests. It emits typed events (`contact`, `flick`, `turn`, `goal`, `whistle`, `play`, `kick`, `win`, …), and the app subscribes to them for audio, FX and UI. Every match subscription is unsubscribed on teardown. The smoke test checks that listener and input-handler counts stay constant across restarts, new matches and tournament ties.

## Offline / install

`scripts/sw-plugin.mjs` writes `dist/sw.js` at build time with a precache list of every emitted file. Pages load network-first with a cached fallback, and assets load cache-first. The app owns `public/manifest.webmanifest` and `public/icons/`. The service worker registers only in production over HTTPS or on localhost.

## Notes

- The starter's Preview Tweak bridge (`scripts/manus-tuning`, Vite plugin) is left in place but has no parameter catalog. The in-game overlay above replaces it and also works on a phone.
- Fonts: Bangers (OFL), Permanent Marker (Apache 2.0) and ManusCC0 (CC0), with licences in `public/fonts/`. Caps, pitches and particles are drawn procedurally, and all audio is synthesised. The OG cover (`public/share/og.png`) and sharing favicon (`public/share/favicon.png`) are local project files.


## Phase 4 — local AI and online prototype

Quick Match can now be played solo against a selectable AI difficulty. It searches candidate flicks by rehearsing them against the same Matter.js match rules in a hidden copy, then performs a real drag-back flick; the live board is not mutated while the AI is thinking.

The local online mode creates a private two-seat room and a `?room=CODE` invitation link. The server—not either browser—runs the shared Matter.js simulation and decides flick legality, turns, goals and wins. Clients show the local flick immediately and reconcile to sequenced server snapshots. The server requires an exact allowed browser `Origin`, bounds packet size/rate, rooms and connections, uses a per-tab resume credential sent in the first WebSocket packet (not the invite URL), pauses after a disconnect and allows a 60-second resume window. Rooms and scores are in memory only; empty rooms expire. This is a casual prototype, not an anti-cheat/ranked service.

To run it locally, use two terminals. Start the server with your exact local page origin in the allowlist:

```bash
CAPBALL_ALLOWED_ORIGINS=http://localhost:3000 npm run online:server
```

Then run Vite with the loopback WebSocket endpoint:

```bash
CAPBALL_WS_URL=ws://127.0.0.1:8787/ws npm run dev
```

Use the same browser page origin `http://localhost:3000`. On Windows PowerShell, set the environment variables with `$env:CAPBALL_ALLOWED_ORIGINS = 'http://localhost:3000'` and `$env:CAPBALL_WS_URL = 'ws://127.0.0.1:8787/ws'` in their respective terminals before running those commands. For automated two-browser coverage, `npm run smoke` starts isolated local services itself; `npm run online:test` runs protocol/room tests.

A static build writes `dist/multiplayer/bootstrap.json`; `CAPBALL_WS_URL` must be a verified WSS endpoint at build time for a published site. The current build intentionally has an empty endpoint, and no cloud host, public WSS service, database, or leaderboard is configured. Local smoke tests do not prove internet access, TLS/reverse-proxy behavior, latency/jitter tolerance or service persistence. Do not expose the default loopback server directly to the internet.
