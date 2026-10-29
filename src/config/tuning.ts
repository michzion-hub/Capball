/**
 * CAPBALL — the ONE tuning file.
 * Every number that changes how the game feels lives here: physics, pitch geometry,
 * input limits, cap types, surfaces and effects. Nothing else hard-codes feel values.
 *
 * Units: world units (wu) on a 1000 × 620 pitch. Matter.js velocities are expressed in
 * wu per Matter "base tick" (1000/60 ms); accelerations below are in velocity-units per second.
 */

export const PHYSICS = {
  /** Fixed simulation rate. High rate keeps fast caps from tunnelling through thin posts. */
  stepHz: 240,
  /** Hard cap on steps per rendered frame (prevents spiral of death after a tab stall). */
  maxStepsPerFrame: 24,
  /** Matter iterations — more = stiffer contacts between stacked caps. */
  positionIterations: 10,
  velocityIterations: 8,
  /** Below this speed a body counts as stationary for settling. Coulomb friction zeroes it anyway. */
  restSpeed: 0.02,
  restAngularSpeed: 0.002,
  /** Everything must stay at rest this long before the turn may change. */
  settleHoldMs: 180,
  /** Safety: a play never lasts longer than this. Bodies are then braked by friction ramp (still physical). */
  maxPlayMs: 20000,
  /** Safety velocity clamp (wu/tick) — well above any legal flick, only stops numerical explosions. */
  maxSpeed: 60,
  /** Angular sliding friction (rad/tick per second) — spin dies off at a constant rate. */
  spinFriction: 0.32,
  /**
   * Curl: a spinning body's heading turns at curl × angularVelocity (rad/s per rad/tick).
   * The velocity vector is rotated, never lengthened, so curl adds no speed and no extra friction.
   */
  curl: 2.6,
  /** Share of a cap's spin handed to the ball when they touch (spun caps bend the ball too). */
  spinTransfer: 0.55,
  /** Fraction of tangential contact speed converted into spin on collisions (visual, Matter handles it). */
  contactFriction: 0.04,
} as const

export const PITCH = {
  width: 1000,
  height: 620,
  /** Wall thickness of boards (thick static boxes never tunnel). */
  boardThickness: 120,
  goalWidth: 170,
  goalDepth: 54,
  postRadius: 8,
  centerCircle: 86,
  penaltyBox: { depth: 160, width: 330 },
  goalBox: { depth: 64, width: 220 },
  penaltySpot: 118,
  /** Space drawn around the pitch (for boards and goals) in world units. */
  viewMargin: 78,
} as const

export const BALL = {
  radius: 12,
  density: 0.0011,
  restitution: 0.82,
  /** Rolling ball: lower sliding friction than caps. (velocity-units per second) */
  friction: 6.5,
} as const

export const INPUT = {
  /** Drag shorter than this (in world units) cancels the flick. */
  minDrag: 18,
  /** Drag length that gives full power — the power cap. Longer drags are clamped. */
  maxDrag: 170,
  /** Impulse at full power (mass × wu/tick). Resulting speed = impulse × power / mass. */
  maxImpulse: 58,
  /** Power curve exponent (>1 gives finer control at low power). */
  powerCurve: 1.35,
  /** Extra finger slop when picking a cap on touch screens (screen px). */
  touchPickSlopPx: 26,
  mousePickSlopPx: 8,
  /** Spin at a full off-centre grab (rad per base tick, ~3 rev/s). */
  maxSpin: 0.32,
  /** Grabs closer to the centre than this fraction of the grab radius give no spin. */
  spinDeadzone: 0.3,
} as const

/** Stuck-ball rule: a pinned ball that hasn't moved for `ruleset.deadBallTurns` plays is dropped back in. */
export const DEADBALL = {
  /** Ball moved less than this during a play = didn't move. */
  moveEps: 3,
  /** Ball centre within ball radius + this of a board/post counts as against it. */
  edgeMargin: 5,
  /** A cap this close (gap, wu) to a ball on the boards is pinning it. */
  pinGap: 3,
  /** How far toward the centre the ref drops the ball. */
  dropDistance: 80,
  /** Caps are moved out of this radius around the drop spot. */
  clearRadius: 48,
} as const

export type CapTypeId = 'standard' | 'defender' | 'winger' | 'keeper' | 'striker'

export interface CapType {
  id: CapTypeId
  label: string
  short: string
  blurb: string
  radius: number
  density: number
  restitution: number
  /** Sliding friction (velocity-units per second). Higher = grippier, stops sooner. */
  grip: number
  /** Flick impulse multiplier. */
  power: number
}

export const CAP_TYPES: Record<CapTypeId, CapType> = {
  standard: { id: 'standard', label: 'Cap', short: 'CAP', blurb: 'Plain old bottle cap.', radius: 22, density: 0.002, restitution: 0.55, grip: 15, power: 1 },
  defender: { id: 'defender', label: 'Heavy Defender', short: 'DEF', blurb: 'Heavy, dead bounce. Hard to shift, hard to stop.', radius: 25, density: 0.0034, restitution: 0.3, grip: 16, power: 1.55 },
  winger: { id: 'winger', label: 'Slippery Winger', short: 'WNG', blurb: 'Light and greasy. Slides for days, pings off boards.', radius: 20, density: 0.0016, restitution: 0.78, grip: 8.5, power: 0.92 },
  keeper: { id: 'keeper', label: 'Sticky Keeper', short: 'GK', blurb: 'Grippy rubber base. Stops dead, soaks up shots.', radius: 24, density: 0.0026, restitution: 0.18, grip: 30, power: 1.25 },
  striker: { id: 'striker', label: 'Strong Striker', short: 'STR', blurb: 'Loaded spring. Hits the ball hardest.', radius: 22, density: 0.0021, restitution: 0.5, grip: 14, power: 1.35 },
}

/** Positional lineup used from Phase 2 (index = cap slot). */
export const LINEUP: CapTypeId[] = ['keeper', 'defender', 'defender', 'winger', 'striker']
/** Phase 1 lineup: five identical caps. */
export const PLAIN_LINEUP: CapTypeId[] = ['standard', 'standard', 'standard', 'standard', 'standard']

export type SurfaceId = 'park' | 'dusty' | 'rooftop' | 'court' | 'slope'

export interface Surface {
  id: SurfaceId
  name: string
  blurb: string
  /** Multiplies every body's sliding friction (cap grip / ball friction). */
  frictionScale: number
  /** Board restitution. */
  boardBounce: number
  /** Constant acceleration (velocity-units per second) — the slope. */
  slope: { x: number; y: number }
  /** Dust emitted per unit of sliding (0 = none). */
  dust: number
  dustColor: string
}

export const SURFACES: Record<SurfaceId, Surface> = {
  park: { id: 'park', name: 'Park Patch', blurb: 'Balding grass. Honest and fair.', frictionScale: 1, boardBounce: 0.6, slope: { x: 0, y: 0 }, dust: 0.15, dustColor: '#9fbf7a' },
  dusty: { id: 'dusty', name: 'Dusty Lot', blurb: 'Gravel and grit. Caps bite, clouds fly.', frictionScale: 1.3, boardBounce: 0.45, slope: { x: 0, y: 0 }, dust: 1, dustColor: '#d8b98a' },
  rooftop: { id: 'rooftop', name: 'Rooftop', blurb: 'Tar paper up high. Concrete ledges kill bounce.', frictionScale: 0.95, boardBounce: 0.3, slope: { x: 0, y: 0 }, dust: 0.25, dustColor: '#b9b9c2' },
  court: { id: 'court', name: 'Slippery Court', blurb: 'Fresh lacquer. Everything skates and the boards spring.', frictionScale: 0.5, boardBounce: 0.85, slope: { x: 0, y: 0 }, dust: 0, dustColor: '#ffffff' },
  slope: { id: 'slope', name: 'The Hill', blurb: 'Built on a slope. Rolls drift toward the bottom touchline.', frictionScale: 1, boardBounce: 0.55, slope: { x: 0, y: 3.2 }, dust: 0.3, dustColor: '#b7c98a' },
}

export const FX = {
  shakeOnGoal: 18,
  shakePerImpact: 0.22,
  shakeMax: 14,
  shakeDecay: 7,
  /** Replay shows this much lead-up before the goal … */
  replaySeconds: 2.2,
  /** … and this much after it, at replaySpeed (0.4 = 2.5× slower). */
  replayTail: 0.8,
  replaySpeed: 0.4,
  celebrateMs: 1500,
  resetTweenMs: 650,
} as const

export const TEAM_DEFAULTS = [
  { name: 'Gutter Kings', primary: '#ff5a1f', secondary: '#1b1b1b', pattern: 'solid' as const },
  { name: 'Rooftop Rats', primary: '#1e9bff', secondary: '#ffffff', pattern: 'solid' as const },
]

/**
 * AI opponent. The AI rehearses candidate flicks in a hidden copy of the match (same physics, same rules),
 * scores where everything ends up, then plays the best one with human-like aim/power error.
 * `candidates` = how many flicks it rehearses; `aimNoise` = radians of aim error (1σ); `powerNoise` = relative power error.
 */
export type AiLevel = 'easy' | 'medium' | 'hard'
export interface AiLevelConfig { name: string; blurb: string; candidates: number; aimNoise: number; powerNoise: number; trySpin: boolean; usePowerShot: boolean }
export const AI = {
  levels: {
    easy: { name: 'Sunday League', blurb: 'Hoofs it. Misses plenty.', candidates: 10, aimNoise: 0.10, powerNoise: 0.18, trySpin: false, usePowerShot: false },
    medium: { name: 'Five-a-Side', blurb: 'Knows where the goal is.', candidates: 26, aimNoise: 0.04, powerNoise: 0.08, trySpin: false, usePowerShot: true },
    hard: { name: 'Street Legend', blurb: 'Bends it round you. Punishes mistakes.', candidates: 54, aimNoise: 0.014, powerNoise: 0.035, trySpin: true, usePowerShot: true },
  } as Record<AiLevel, AiLevelConfig>,
  /** Pause before the AI starts "dragging", then how long the visible drag-back lasts. */
  thinkMs: 650,
  dragMs: 620,
  /** Longest a rehearsal may run (game ms) before it is scored as-is. */
  rehearsalMaxMs: 9000,
  /** Evaluation weights (points). Goals dominate; everything else shapes the "good position" score. */
  weights: {
    goal: 10000,
    penaltyAgainst: 3000,
    freeKickAgainst: 260,
    cornerFor: 160,
    cornerAgainst: 220,
    goalKickAgainst: 70,
    offside: 160,
    bonus: 260,
    ballNearTheirGoal: 420,
    ballNearOurGoal: 560,
    control: 130,
    keeperOffLine: 0.7,
  },
} as const
