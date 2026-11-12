import { makeRng } from '../ai/brain'
import type { Ruleset } from '../config/rulesets'
import type { TeamDesign } from '../render/capArt'

/** Two rival crews join the two player-designed crews for a four-team knockout. */
export const RIVAL_CREWS: TeamDesign[] = [
  { name: 'Alley Cats', primary: '#2fbf71', secondary: '#0f2a1a', pattern: 'stripes', numbers: ['1', '2', '3', '8', '10'], capNames: ['Whiskers', 'Bin Lid', 'Moggy', 'Scratch', 'Tom'] },
  { name: 'Concrete Cobras', primary: '#ffd23f', secondary: '#1b1b1b', pattern: 'hoops', numbers: ['1', '3', '6', '11', '99'], capNames: ['Fangs', 'Slab', 'Rebar', 'Hiss', 'Venom'] },
]

/**
 * Versus-AI tournaments need three computer crews so the human's custom side is the only
 * player-controlled team. Local 2P keeps the original two rivals.
 */
export const AI_RIVAL_CREWS: TeamDesign[] = [
  ...RIVAL_CREWS,
  { name: 'Pigeon Patrol', primary: '#9aa3b2', secondary: '#3b2b4a', pattern: 'split', numbers: ['2', '5', '7', '9', '11'], capNames: ['Pecky', 'Coo', 'Wingnut', 'Beak', 'Flap'] },
]

export interface TieResult {
  home: number
  away: number
  goals: [number, number]
  winner: number
  shootout?: [number, number]
  /** Resolved by the deterministic street-AI simulation rather than a played match. */
  simulated?: boolean
}

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

  record(id: Tie['id'], goals: [number, number], winnerSide: 0 | 1, shootout?: [number, number], simulated = false): void {
    const tie = this.ties.find(t => t.id === id)
    if (!tie || tie.result || tie.home === null || tie.away === null) throw new Error(`cannot record ${id}`)
    const winner = winnerSide === 0 ? tie.home : tie.away
    tie.result = { home: tie.home, away: tie.away, goals, winner, shootout, simulated }
    const final = this.ties[2]
    if (id === 'sf1') final.home = winner
    if (id === 'sf2') final.away = winner
  }
}

export interface SimulatedTie {
  goals: [number, number]
  winnerSide: 0 | 1
  shootout?: [number, number]
}

/** Stable per-crew strength in 0..1, derived only from presentation data. */
function crewRating(team: TeamDesign): number {
  let h = 2166136261
  for (const ch of `${team.name}|${team.primary}|${team.secondary}|${team.pattern}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  }
  return (h >>> 0) / 4294967295
}

/** A tie gets its own seed so bracket order and extra simulations cannot change its result. */
function tieSeed(seed: number, id: Tie['id']): number {
  const tag = id === 'sf1' ? 0x9e3779b9 : id === 'sf2' ? 0x85ebca6b : 0xc2b2ae35
  return (Math.imul(seed >>> 0, 1664525) + tag) >>> 0
}

function simulateShootout(rng: () => number): [number, number] {
  let home = 0
  let away = 0
  for (let i = 0; i < 5; i++) {
    if (rng() < 0.72) home++
    if (rng() < 0.72) away++
  }
  let guard = 0
  while (home === away && guard++ < 24) {
    if (rng() < 0.72) home++
    if (rng() < 0.72) away++
  }
  if (home === away) home++
  return [home, away]
}

/**
 * Resolve an AI-only fixture without pretending the human played it.
 *
 * The shape follows the active ruleset: target-goal street matches stop at the target,
 * timed matches can draw and then go to a shootout. A seeded RNG keyed by tournament
 * seed + tie id keeps the bracket reproducible and independent of simulation order.
 */
export function simulateAiTie(
  seed: number,
  id: Tie['id'],
  home: TeamDesign,
  away: TeamDesign,
  ruleset: Pick<Ruleset, 'goalsToWin' | 'halves'>,
): SimulatedTie {
  const rng = makeRng(tieSeed(seed, id) / 4294967296)
  const edge = Math.max(-1, Math.min(1, crewRating(home) - crewRating(away)))

  if (ruleset.goalsToWin !== null) {
    const target = Math.max(1, Math.min(9, ruleset.goalsToWin))
    const homeChance = Math.max(0.28, Math.min(0.72, 0.5 + edge * 0.22))
    const winnerSide: 0 | 1 = rng() < homeChance ? 0 : 1
    const loser = Math.min(target - 1, Math.floor(rng() * target))
    return {
      goals: winnerSide === 0 ? [target, loser] : [loser, target],
      winnerSide,
    }
  }

  const goalsFor = (bias: number) => Math.max(0, Math.min(6, Math.round(rng() * 3.2 + Math.max(0, bias) * 1.6)))
  const goals: [number, number] = [goalsFor(edge), goalsFor(-edge)]
  if (goals[0] !== goals[1]) return { goals, winnerSide: goals[0] > goals[1] ? 0 : 1 }
  const shootout = simulateShootout(rng)
  return { goals, winnerSide: shootout[0] > shootout[1] ? 0 : 1, shootout }
}
