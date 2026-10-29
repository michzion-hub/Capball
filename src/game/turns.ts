import type { TeamIndex } from '../physics/world'

export type Phase =
  | 'aim'      // current team may flick one of its caps
  | 'moving'   // a flick is in progress; waiting for everything to settle
  | 'goal'     // goal celebration (physics still running in the net)
  | 'replay'   // slow-motion replay
  | 'reset'    // caps sliding back into formation / set-piece placement (no physics)
  | 'over'     // match finished

export type TurnReason = 'kickoff' | 'normal' | 'bonus' | 'freekick' | 'penalty' | 'corner' | 'goalkick' | 'dropball' | 'offside' | 'halftime' | 'keeper' | 'shootout'

export interface TurnState {
  phase: Phase
  team: TeamIndex
  turn: number
  /** Flicks taken during the current turn (always ≤ 1 per turn; bonus starts a new turn for the same team). */
  flicks: number
  reason: TurnReason
}

/**
 * Pure turn rules. The machine refuses illegal transitions instead of trusting callers:
 * - one flick per turn, only by the team on turn, only in `aim`;
 * - the next turn only starts after `settled()` (or after a goal reset).
 */
export class TurnMachine {
  state: TurnState
  constructor(first: TeamIndex = 0) {
    this.state = { phase: 'aim', team: first, turn: 1, flicks: 0, reason: 'kickoff' }
  }

  reset(first: TeamIndex): void {
    this.state = { phase: 'aim', team: first, turn: 1, flicks: 0, reason: 'kickoff' }
  }

  canFlick(capTeam: TeamIndex): boolean {
    const s = this.state
    return s.phase === 'aim' && s.flicks === 0 && capTeam === s.team
  }

  /** Returns false (and changes nothing) if the flick is not allowed. */
  flick(capTeam: TeamIndex): boolean {
    if (!this.canFlick(capTeam)) return false
    this.state = { ...this.state, phase: 'moving', flicks: 1 }
    return true
  }

  goal(): boolean {
    if (this.state.phase !== 'moving') return false
    this.state = { ...this.state, phase: 'goal' }
    return true
  }

  enter(phase: 'replay' | 'reset'): void {
    if (this.state.phase === 'over') return
    this.state = { ...this.state, phase }
  }

  /** Everything has stopped. Hand the turn to `next` (same team = bonus/set piece). */
  settled(next: TeamIndex, reason: TurnReason): boolean {
    if (this.state.phase !== 'moving') return false
    this.startTurn(next, reason)
    return true
  }

  /** Start a turn after a reset (kickoff, set-piece placement). */
  startTurn(team: TeamIndex, reason: TurnReason): void {
    if (this.state.phase === 'over') return
    this.state = { phase: 'aim', team, turn: this.state.turn + 1, flicks: 0, reason }
  }

  finish(): void {
    this.state = { ...this.state, phase: 'over' }
  }
}
