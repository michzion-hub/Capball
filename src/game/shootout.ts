import type { TeamIndex } from '../physics/world'

/** Kick order through the crew: striker, winger, defenders, then the keeper (comedy). */
export const TAKER_ORDER = [4, 3, 1, 2, 0] as const

/** Pure shootout scoring: best of `rounds`, then sudden death, with early finish. */
export class ShootoutScore {
  readonly kicks: [boolean[], boolean[]] = [[], []]

  constructor(readonly first: TeamIndex = 0, readonly rounds = 5) {}

  goals(t: TeamIndex): number { return this.kicks[t].filter(Boolean).length }
  taken(t: TeamIndex): number { return this.kicks[t].length }

  /** Team to kick next. */
  get kicker(): TeamIndex {
    const other = (1 - this.first) as TeamIndex
    return this.taken(this.first) === this.taken(other) ? this.first : other
  }

  /** Slot of the cap taking the next kick for team t. */
  takerSlot(t: TeamIndex): number { return TAKER_ORDER[this.taken(t) % TAKER_ORDER.length] }

  get suddenDeath(): boolean { return this.taken(0) >= this.rounds && this.taken(1) >= this.rounds }

  record(scored: boolean): void {
    if (this.winner !== null) return
    this.kicks[this.kicker].push(scored)
  }

  /** Winner as soon as it is mathematically decided, else null. */
  get winner(): TeamIndex | null {
    const g0 = this.goals(0), g1 = this.goals(1)
    const t0 = this.taken(0), t1 = this.taken(1)
    if (t0 <= this.rounds && t1 <= this.rounds) {
      const left0 = this.rounds - t0, left1 = this.rounds - t1
      if (g0 > g1 + left1) return 0
      if (g1 > g0 + left0) return 1
      if (t0 < this.rounds || t1 < this.rounds) return null
    }
    // Sudden death: decided only after equal kicks.
    if (t0 === t1 && g0 !== g1) return g0 > g1 ? 0 : 1
    return null
  }
}
