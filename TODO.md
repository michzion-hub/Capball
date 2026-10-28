# CAPBALL TODO

## Phase 1 — Core game (must be stable before Phase 2)
- [x] Pitch: top-down touch-friendly pitch with markings and goals with solid posts; two clearly different team colours; responsive on desktop and mobile.
- [x] Physics: circular Matter.js bodies with a fixed timestep; all tuning in one config file; friction applied only once; caps slide, collide and settle naturally; nothing teleports or moves a fixed distance.
- [x] Controls: drag-back flick with direction arrow and power meter, power cap and minimum drag; mouse and touch; page scrolling blocked.
- [x] Turns: local two-player, 5 caps per team, one flick per turn, next turn only when everything has settled; goals count exactly once; first to 3 wins.
- [x] UI: start screen, scoreboard, turn indicator, rules panel, Restart and New match buttons, sound toggle, winner screen.
- [x] Structure/tests: separate physics, rendering, input, turns, rules and UI modules; tests for goal, turn, settling and restart logic; installs, builds and runs.

## Phase 2 — Unique mechanics
- [x] Cap types with different weight, bounce and grip — heavy defender, slippery winger, sticky goalkeeper, strong striker — shown visually.
- [x] Boards as a teammate: ball bounces off a board then touches your cap → bonus flick.
- [x] Combos: chaining passes between your caps charges a power shot.
- [x] Rules as swappable settings in one ruleset config: timed halves, corners, free kicks, penalties, optional offside, loose arcade mode.
- [x] Street pitches: dusty lot, rooftop, slippery court, slightly sloped pitch.

## Phase 3 — Polish and feel
- [x] Screen shake, dust particles, goal celebrations, slow-motion replay of goals, impact sounds varying with collision force, crowd noise, commentator.
- [x] Design-your-own cap: colour, pattern, number and name.
- [x] Match modes: quick match, penalty shootout, short tournament.
- [x] Playable offline as an installable mobile web app.

## Phase 4 — AI, online and leaderboards
- [x] AI opponent: local single-player mode with selectable difficulty; the opponent chooses and executes real physics flicks.
- [x] Local online prototype: two independent browser seats, shareable room-code links, turn ownership, authoritative game simulation, state sync, disconnect pause and resume. Two-browser testing passes.
- [ ] Public online matches: select an authorized cloud host, deploy and secure the TLS/WSS service, then verify the published game with two players. No host is selected or public service deployed.
- [ ] Leaderboards: decide what a fair ranked result is for this game, then explicitly approve the server/database cost before any hosted database or leaderboard is enabled. Local two-player matches are not suitable for a competitive global ranking by default.

## Explicit exclusions
AI design expansion, online spectators, durable accounts, cash-prize/ranked competition, and Phase 4 services not approved above are not being implemented. No online or leaderboard claims are made until their release checks pass.

## Portable build and export
- [x] Image/font assets are regular project files under `public/` (including share images and icons); game art is drawn with Canvas and audio is synthesized with WebAudio, so there are no remote image/sound files to restore.
- [x] Remove `restore.mjs` from the `dev` and `build` commands in `package.json`; `build` runs `tsc --noEmit && vite build`.
- [x] All scripts used by the build/dev flow are in the project; the build-required Vite plugins are local and the standard package scripts list the commands.
- [x] In a fresh copy without `node_modules`, `npm install` followed by `npm run build` succeeds, including with the restore helper and legacy asset-store copies absent.
- [x] GitHub connector is disabled, so provide a complete source export and specify the exact files/folders to upload instead of attempting a push.

Verification: fresh npm install/build passed; 84 unit tests passed (one optional physics probe is skipped); browser smoke passed; `npm audit` reported 0 vulnerabilities after updating `ws` to 8.22.0.
