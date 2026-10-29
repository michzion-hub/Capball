import type { TeamDesign } from '../render/capArt'

/** Two rival crews join the two player-designed crews for a four-team knockout. */
export const RIVAL_CREWS: TeamDesign[] = [
  { name: 'Alley Cats', primary: '#2fbf71', secondary: '#0f2a1a', pattern: 'stripes', numbers: ['1', '2', '3', '8', '10'], capNames: ['Whiskers', 'Bin Lid', 'Moggy', 'Scratch', 'Tom'] },
  { name: 'Concrete Cobras', primary: '#ffd23f', secondary: '#1b1b1b', pattern: 'hoops', numbers: ['1', '3', '6', '11', '99'], capNames: ['Fangs', 'Slab', 'Rebar', 'Hiss', 'Venom'] },
]

export interface TieResult { home: number; away: number; goals: [number, number]; winner: number; shootout?: [number, number] }

export interface Tie { id: 'sf1' | 'sf2' | 'final'; label: string; home: number | null; away: number | null; result: TieResult | null }

/**
 * Pure bracket: crews 0..3. Semi 1: crew 0 vs crew 2, Semi 2: crew 1 vs crew 3, then the final.
 */
export class Tournament {
  readonly ties: Tie[]
  constructor(readonly crews: TeamDesign[]) {
    if (crews.length !== 4) throw new Error('tournament needs exactly 4 crews')
    this.ties = [
      { id: 'sf1', label: 'Semi-final 1', home: 0, away: 2, result: null },
      { id: 'sf2', label: 'Semi-final 2', home: 1, away: 3, result: null },
      { id: 'final', label: 'The Final', home: null, away: null, result: null },
    ]
  }

  /** Next tie to play, or null when the champion is known. */
  get next(): Tie | null {
    return this.ties.find(t => !t.result && t.home !== null && t.away !== null) ?? null
  }

  get champion(): number | null {
    return this.ties[2].result?.winner ?? null
  }

  record(id: Tie['id'], goals: [number, number], winnerSide: 0 | 1, shootout?: [number, number]): void {
    const tie = this.ties.find(t => t.id === id)
    if (!tie || tie.result || tie.home === null || tie.away === null) throw new Error(`cannot record ${id}`)
    const winner = winnerSide === 0 ? tie.home : tie.away
    tie.result = { home: tie.home, away: tie.away, goals, winner, shootout }
    const final = this.ties[2]
    if (id === 'sf1') final.home = winner
    if (id === 'sf2') final.away = winner
  }
}
