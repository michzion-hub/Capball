import type { TeamIndex } from '../physics/world'
import type { TrackerEvent } from './play'

export interface MatchStatisticsSnapshot {
  elapsedMs: number
  flicks: [number, number]
  powerShots: [number, number]
  passes: [number, number]
  boardBonuses: [number, number]
}

/** Small, match-scoped counters for the full-time summary; this does not affect play. */
export class MatchStatistics {
  private elapsedMs = 0
  private flicks: [number, number] = [0, 0]
  private powerShots: [number, number] = [0, 0]
  private passes: [number, number] = [0, 0]
  private boardBonuses: [number, number] = [0, 0]

  advance(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.elapsedMs += ms
  }

  recordFlick(team: TeamIndex, powerShot: boolean): void {
    this.flicks[team]++
    if (powerShot) this.powerShots[team]++
  }

  recordPlay(event: TrackerEvent): void {
    if (event.type === 'pass') this.passes[event.team]++
    else if (event.type === 'boardBonus') this.boardBonuses[event.team]++
  }

  snapshot(): MatchStatisticsSnapshot {
    return {
      elapsedMs: this.elapsedMs,
      flicks: [...this.flicks],
      powerShots: [...this.powerShots],
      passes: [...this.passes],
      boardBonuses: [...this.boardBonuses],
    }
  }

  reset(): void {
    this.elapsedMs = 0
    this.flicks = [0, 0]
    this.powerShots = [0, 0]
    this.passes = [0, 0]
    this.boardBonuses = [0, 0]
  }
}
