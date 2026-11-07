import type { PenaltyTimeoutAction } from './football'

/**
 * Rulesets — swap a whole ruleset or tweak a single flag to try a new version of the game.
 * The rule engine (src/game/rules.ts) only ever reads these flags.
 */

export interface Ruleset {
  id: string
  name: string
  blurb: string
  /** First to N goals wins. null = no goal target (timed only). */
  goalsToWin: number | null
  /** Timed halves (real seconds, clock runs while a turn is live). null = untimed. */
  halves: { count: number; seconds: number } | null
  /** Cap types (heavy defender, slippery winger, …). false = five plain caps. */
  capTypes: boolean
  /** Ball off byline board, last touched by defender → corner; by attacker → goal kick. */
  corners: boolean
  /** Flicked cap hits an opponent cap before touching the ball → free kick where it happened. */
  freeKicks: boolean
  /** A free-kick foul inside the fouling team's own box becomes a penalty. Needs freeKicks. */
  penalties: boolean
  /** Passing to a cap that was offside at the moment of the flick → free kick to defenders. */
  offside: boolean
  /** Ball off a board then onto your own cap → one bonus flick. */
  boardBonus: boolean
  /** Passes between your own caps charge a power shot. */
  combos: { enabled: boolean; passesForPowerShot: number; powerMultiplier: number }
  /** Opponent caps must keep this far from a free-kick ball (world units). */
  wallDistance: number
  /** With corners on: the ball must hit the end board at least this hard to be out. Softer touches play on. */
  outMinImpact: number
  /**
   * Who gives the ball away when it goes out over an end line.
   * 'flick': the team whose flick sent it out (deflections don't matter) — easy to read at a glance.
   * 'lastTouch': whichever cap touched the ball last, like real football.
   */
  outBy: 'flick' | 'lastTouch'
  /** Off-centre grabs put spin on the cap, which curls its path (and the ball's). */
  spin: boolean
  /** A ball pinned against the boards that stays put for this many plays is dropped back in. 0 = never. */
  deadBallTurns: number
  /** Opponents stay outside the penalty area until a goal kick leaves it; otherwise retake. */
  goalKickRestriction: boolean
  /** Delay a foul whistle when the fouled team can retain a clearly better attacking position. */
  advantage: boolean
  /** Goalkeepers are returned to their own goal area between plays if pushed outside it. */
  keeperBox: boolean
  /** Local two-player hidden keeper/shooter commit–reveal for open-play penalties. */
  hiddenPenalties: boolean
  /** During hidden penalties, allow the keeper to move inside the six-yard goal area. */
  keeperMayLeaveLine: boolean
  /** Shooter timeout policy for hidden penalties. */
  penaltyTimeout: PenaltyTimeoutAction
}

const base: Omit<Ruleset, 'id' | 'name' | 'blurb'> = {
  goalsToWin: 3,
  halves: null,
  capTypes: true,
  corners: false,
  freeKicks: false,
  penalties: false,
  offside: false,
  boardBonus: true,
  combos: { enabled: true, passesForPowerShot: 3, powerMultiplier: 1.6 },
  wallDistance: 70,
  spin: true,
  deadBallTurns: 2,
  outMinImpact: 2,
  outBy: 'flick',
  goalKickRestriction: true,
  advantage: true,
  keeperBox: true,
  hiddenPenalties: false,
  keeperMayLeaveLine: false,
  penaltyTimeout: 'straight',
}

export const RULESETS = {
  /** Phase 1 baseline: five plain caps, first to 3, no extras. */
  basic: { ...base, id: 'basic', name: 'Bare Bones', blurb: 'Five plain caps, first to 3. No gimmicks.', capTypes: false, boardBonus: false, spin: false, combos: { ...base.combos, enabled: false } },
  street: { ...base, id: 'street', name: 'Street Rules', blurb: 'First to 3. Cap types, spin, board bonus, combos, corners and free kicks.', corners: true, freeKicks: true, penalties: true },
  proper: { ...base, id: 'proper', name: 'Proper Football', blurb: 'Two 3-minute halves, corners, free kicks, penalties and offside.', goalsToWin: null, halves: { count: 2, seconds: 180 }, corners: true, freeKicks: true, penalties: true, offside: true, outBy: 'lastTouch' },
  arcade: { ...base, id: 'arcade', name: 'Loose Arcade', blurb: 'No whistles at all. Two passes charge a monster power shot.', goalsToWin: 3, combos: { enabled: true, passesForPowerShot: 2, powerMultiplier: 1.9 } },
} satisfies Record<string, Ruleset>

/** Solo coaching match: real flick physics, boards, cap types and combos, without match-ending or restart whistles. */
export const TUTORIAL_RULESET: Ruleset = {
  ...RULESETS.street,
  id: 'tutorial',
  name: 'Guided Practice',
  blurb: 'A solo practice pitch for learning the real flick, board and pass mechanics.',
  goalsToWin: null,
  halves: null,
  corners: false,
  freeKicks: false,
  penalties: false,
  offside: false,
  boardBonus: true,
  combos: { ...RULESETS.street.combos, enabled: true, passesForPowerShot: 3 },
  spin: false,
  deadBallTurns: 0,
  goalKickRestriction: false,
  advantage: false,
  keeperBox: false,
  hiddenPenalties: false,
  keeperMayLeaveLine: false,
}

export type RulesetId = keyof typeof RULESETS
export const RULESET_ORDER: RulesetId[] = ['street', 'proper', 'arcade', 'basic']

export function getRuleset(id: string): Ruleset {
  return (RULESETS as Record<string, Ruleset>)[id] ?? RULESETS.street
}
