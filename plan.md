# CAPBALL — implementation plan

## Approach
Pure TypeScript + Vite, HTML Canvas 2D rendering, Matter.js 0.20 physics, HTML/CSS overlay UI.
The Three.js starter was removed (the brief asks for a top-down Canvas game "from scratch"); the
Vite config, size budget, preview-tuning dev plugin and smoke harness remain. No 3D models are
used, so the saved 3D model generation choice has no consumer. Fonts, icons and the share artwork
are ordinary local files under `public/`; caps and pitches are drawn in Canvas, and all audio is
synthesised with WebAudio (commentary uses captions plus optional browser speech). `dev` runs Vite
directly; `build` runs `tsc --noEmit && vite build`, with npm and pnpm lockfiles for clean installs.
The client is a static build (`dist`) with an optional Node.js `ws` room service. The room service
imports the existing TypeScript Match/Matter.js rules, owns room seats, turns, physics, scoring and
wins; clients predict their own flick locally and reconcile from sequenced server snapshots. Vite's
`/multiplayer/bootstrap.json` endpoint exposes only the configured public WSS URL. No database or
hosted leaderboard is enabled. Local authoritative room testing is in scope; public play remains
pending an explicitly selected cloud computer, deployed TLS/WSS service, and published two-client
verification.

## Physics model (src/config/tuning.ts is the single tuning file)
- Matter world with zero gravity, fixed 240 Hz step driven by an accumulator (max steps per frame capped).
- Friction is applied exactly once: Matter `frictionAir`, `friction` and `frictionStatic` are all 0;
  one Coulomb sliding-friction pass per step (constant deceleration, clamps to exactly zero) gives
  natural slides with crisp stops. Slope pitches add a constant acceleration before that pass, so
  objects drift downhill only while the slope force beats static grip.
- Flick = impulse; resulting speed = impulse × capType.power / mass. Distance emerges from friction.
- Bounce from Matter restitution (cap types and boards). Posts are static circles; boards/goals are thick static rectangles.
- Settled = every body exactly at rest for a short hold time.

## Modules
- `config/` tuning (physics, cap types, surfaces, input, fx), rulesets, pitch geometry.
- `physics/` world construction, stepping, friction, flick, collision events, snapshots, settle detector.
- `game/` pure rules (goal/foul/corner/offside/board-bonus/combo), turn state machine, play tracker,
  formations and placement solver, match orchestrator, replay recorder, shootout and tournament logic.
- `input/` single pointer handler (mouse + touch via Pointer Events) with attach/detach via AbortController; pure flick math.
- `render/` view transform (auto-rotates in portrait), procedural surface textures, cap art, effects drawing.
- `fx/` particles, screen shake. `audio/` synth SFX, crowd bed, commentator.
- `ui/` DOM screens: start, mode setup, rules, HUD, pause, winner, cap designer, bracket, shootout.
- `public/` tracked fonts, icons, app manifest and sharing artwork; the browser build has no asset-restore dependency.
- `store/` persisted team designs and settings. `pwa/` service worker registration; Vite plugin emits a precache SW.
- `ai/` bounded candidate-flick rehearsal in a hidden Match; `net/` validated room protocol, reconnecting browser client and authoritative snapshot shapes; `server/` bounded two-seat Node WebSocket room service reusing the game Match; `tests/phase4-*` deterministic AI and room tests.

## Design
Candidates: Photocopied street-zine flyer (p=0.07) · 1970s sticker-album nostalgia (p=0.05) · Brutalist concrete signage (p=0.04). Chosen: **photocopied street-zine flyer**.

- **Design Movement**: DIY xerox zines and wheat-paste gig posters.
- **Core Principles**: hand-made over slick; loud contrast; everything looks taped up; play area stays clean and readable.
- **Color Philosophy**: off-white paper and asphalt black as the base; team colours are the only saturated hues so the match reads instantly; Cap Orange marks interaction.
- **Layout Paradigm**: off-axis, slightly rotated paper slips and tape strips around a full-bleed pitch; menus are pinned flyers, not centred cards.
- **Signature Elements**: masking-tape strips, crimped bottle-cap edges, spray-paint stencil numbers.
- **Interaction Philosophy**: every touch has a physical answer — slips tilt on hover, buttons press down like stickers.
- **Animation**: quick snaps (120–220 ms), slight overshoot; banners slam in rotated; no slow fades during play.
- **Typography System**: Bangers for display/scores, Permanent Marker for hand-written labels and commentary, ManusCC0 for body copy.
- **Brand Essence**: Street football for two thumbs and a table — loud, scrappy, physical.
- **Brand Voice**: cheeky touchline banter. "Flick it like you mean it." / "That cap's going home in a bin bag."
- **Wordmark & Logo**: CAPBALL in Bangers with the A replaced by a crimped bottle cap.
- **Signature Brand Color**: Cap Orange #FF5A1F.
