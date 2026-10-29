import { PITCH } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'
import type { TeamIndex } from '../physics/world'

/** Team 0 defends the left goal (end 0) and attacks right; team 1 the opposite. */
export function defendingTeam(end: 0 | 1): TeamIndex {
  return end
}

export function attackDir(team: TeamIndex): 1 | -1 {
  return team === 0 ? 1 : -1
}

/**
 * Which goal (if any) the ball has FULLY crossed into: its whole circle is beyond the goal line
 * and between the posts. Returns -1 when no goal.
 */
export function goalCrossed(x: number, y: number, r: number): -1 | 0 | 1 {
  const top = (PITCH.height - PITCH.goalWidth) / 2
  const bottom = (PITCH.height + PITCH.goalWidth) / 2
  if (y < top || y > bottom) return -1
  if (x < -r) return 0
  if (x > PITCH.width + r) return 1
  return -1
}

/** A ball in goal `end` is a goal for the team that does NOT defend that end. */
export function scorerForEnd(end: 0 | 1): TeamIndex {
  return end === 0 ? 1 : 0
}

export function otherTeam(t: TeamIndex): TeamIndex {
  return t === 0 ? 1 : 0
}

export interface ScoreState {
  goals: [number, number]
}

/**
 * Latch that guarantees a goal is counted exactly once per play, no matter how long
 * the ball keeps rattling around inside the net.
 */
export class GoalLatch {
  private scoredThisPlay = false
  get locked(): boolean { return this.scoredThisPlay }
  /** Returns the scoring team the first time a goal is seen this play; null afterwards. */
  check(x: number, y: number, r: number): { end: 0 | 1; scorer: TeamIndex } | null {
    if (this.scoredThisPlay) return null
    const end = goalCrossed(x, y, r)
    if (end === -1) return null
    this.scoredThisPlay = true
    return { end, scorer: scorerForEnd(end) }
  }
  /** Lock without scoring (e.g. play already whistled dead). */
  lock(): void { this.scoredThisPlay = true }
  reset(): void { this.scoredThisPlay = false }
}

export function addGoal(score: ScoreState, scorer: TeamIndex): ScoreState {
  const goals: [number, number] = [score.goals[0], score.goals[1]]
  goals[scorer] += 1
  return { goals }
}

/** Winner by goal target (first to N). Timed matches decide at the final whistle via timeWinner. */
export function goalTargetWinner(score: ScoreState, rules: Pick<Ruleset, 'goalsToWin'>): TeamIndex | null {
  if (rules.goalsToWin == null) return null
  if (score.goals[0] >= rules.goalsToWin) return 0
  if (score.goals[1] >= rules.goalsToWin) return 1
  return null
}

export function timeWinner(score: ScoreState): TeamIndex | null {
  if (score.goals[0] > score.goals[1]) return 0
  if (score.goals[1] > score.goals[0]) return 1
  return null
}
