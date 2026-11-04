import { describe, expect, it } from 'vitest'
import { MatchStatistics } from '../src/game/summary'

describe('match summary statistics', () => {
  it('counts each team’s flicks, power shots, passes and board bonuses', () => {
    const stats = new MatchStatistics()
    stats.advance(16.7)
    stats.advance(Number.NaN)
    stats.advance(-10)
    stats.recordFlick(0, false)
    stats.recordFlick(1, true)
    stats.recordFlick(0, true)
    stats.recordPlay({ type: 'pass', team: 1, chain: 1, from: 5, to: 6 })
    stats.recordPlay({ type: 'pass', team: 0, chain: 1, from: 1, to: 2 })
    stats.recordPlay({ type: 'boardBonus', team: 0, capId: 4 })
    stats.recordPlay({ type: 'boardHit', at: { x: 20, y: 30 } })

    expect(stats.snapshot()).toEqual({
      elapsedMs: 16.7,
      flicks: [2, 1],
      powerShots: [1, 1],
      passes: [1, 1],
      boardBonuses: [1, 0],
    })
  })

  it('returns detached snapshots and clears all counters for a rematch', () => {
    const stats = new MatchStatistics()
    stats.advance(2500)
    stats.recordFlick(0, true)
    const first = stats.snapshot()
    first.flicks[0] = 99
    expect(stats.snapshot().flicks).toEqual([1, 0])

    stats.reset()
    expect(stats.snapshot()).toEqual({
      elapsedMs: 0,
      flicks: [0, 0],
      powerShots: [0, 0],
      passes: [0, 0],
      boardBonuses: [0, 0],
    })
  })
})
