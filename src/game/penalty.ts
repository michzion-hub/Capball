import type { TeamIndex, Vec } from '../physics/world'
import type { PenaltyTimeoutAction } from '../config/football'
import { FOOTBALL } from '../config/football'
import { PITCH } from '../config/tuning'

export type PenaltyStage = 'cover-keeper' | 'keeper' | 'cover-shooter' | 'shooter' | 'reveal' | 'done'

export interface PenaltyShotChoice {
  direction: Vec
  power: number
}

export function legalKeeperPosition(position: Vec, end: 0 | 1, radius: number, mayLeaveLine: boolean): Vec {
  const halfMouth = PITCH.goalWidth / 2
  const minY = PITCH.height / 2 - halfMouth + radius + FOOTBALL.keeperBoxInset
  const maxY = PITCH.height / 2 + halfMouth - radius - FOOTBALL.keeperBoxInset
  const minX = mayLeaveLine
    ? end === 0 ? radius + FOOTBALL.keeperBoxInset : PITCH.width - PITCH.goalBox.depth + radius + FOOTBALL.keeperBoxInset
    : end === 0 ? radius + FOOTBALL.keeperLineInset : PITCH.width - radius - FOOTBALL.keeperLineInset
  const maxX = mayLeaveLine
    ? end === 0 ? PITCH.goalBox.depth - radius - FOOTBALL.keeperBoxInset : PITCH.width - radius - FOOTBALL.keeperBoxInset
    : minX
  return {
    x: Math.max(minX, Math.min(maxX, position.x)),
    y: Math.max(minY, Math.min(maxY, position.y)),
  }
}

/**
 * Local pass-the-device penalty flow. The state machine never serializes or transmits either
 * choice; the app reads both only after the shooter commits (or times out).
 */
export class HiddenPenalty {
  stage: PenaltyStage = 'cover-keeper'
  elapsedMs = 0
  keeperPosition: Vec | null = null
  candidateShot: PenaltyShotChoice | null = null
  committedShot: PenaltyShotChoice | null = null
  forfeited = false

  constructor(
    readonly kicker: TeamIndex,
    readonly keeperTeam: TeamIndex,
    readonly takerId: number,
    readonly keeperId: number,
    readonly end: 0 | 1,
    readonly timeoutMs: number,
  ) {}

  dismissCover(): boolean {
    if (this.stage === 'cover-keeper') this.stage = 'keeper'
    else if (this.stage === 'cover-shooter') this.stage = 'shooter'
    else return false
    this.elapsedMs = 0
    return true
  }

  lockKeeper(position: Vec): boolean {
    if (this.stage !== 'keeper') return false
    this.keeperPosition = { ...position }
    this.stage = 'cover-shooter'
    this.elapsedMs = 0
    return true
  }

  stageShot(choice: PenaltyShotChoice): boolean {
    if (this.stage !== 'shooter') return false
    const length = Math.hypot(choice.direction.x, choice.direction.y)
    if (!Number.isFinite(length) || length < 0.001 || !Number.isFinite(choice.power)) return false
    this.candidateShot = {
      direction: { x: choice.direction.x / length, y: choice.direction.y / length },
      power: Math.max(0, Math.min(1, choice.power)),
    }
    return true
  }

  lockShot(): boolean {
    if (this.stage !== 'shooter' || !this.candidateShot) return false
    this.committedShot = { direction: { ...this.candidateShot.direction }, power: this.candidateShot.power }
    this.stage = 'reveal'
    this.elapsedMs = 0
    return true
  }

  timeoutKeeper(fallback: Vec): boolean {
    if (this.stage !== 'keeper') return false
    return this.lockKeeper(fallback)
  }

  timeoutShooter(action: PenaltyTimeoutAction, straight: PenaltyShotChoice): boolean {
    if (this.stage !== 'shooter') return false
    if (action === 'forfeit') return this.forfeit()
    this.committedShot = {
      direction: { ...straight.direction },
      power: Math.max(0, Math.min(1, straight.power)),
    }
    this.stage = 'reveal'
    this.elapsedMs = 0
    return true
  }

  forfeit(): boolean {
    if (this.stage !== 'shooter') return false
    this.forfeited = true
    this.committedShot = null
    this.stage = 'reveal'
    this.elapsedMs = 0
    return true
  }

  tick(dtMs: number): boolean {
    if (this.stage !== 'keeper' && this.stage !== 'shooter') return false
    this.elapsedMs += Math.max(0, dtMs)
    return this.elapsedMs >= this.timeoutMs
  }

  finish(): void {
    this.stage = 'done'
    this.candidateShot = null
    this.committedShot = null
    this.elapsedMs = 0
  }
}
