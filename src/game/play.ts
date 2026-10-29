import { PITCH } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'
import type { BodyTag, CapInfo, Contact, TeamIndex, Vec } from '../physics/world'
import { attackDir, defendingTeam, otherTeam } from './rules'
import type { TurnReason } from './turns'

export interface CapPos { id: number; team: TeamIndex; x: number; y: number }

/**
 * Caps of `team` in an offside position at the moment of the flick:
 * in the opponent half, and nearer the opponent goal line than both the ball and the
 * second-last opponent cap. The flicker itself can never be offside.
 */
export function offsideCaps(team: TeamIndex, caps: CapPos[], ball: Vec, flickerId: number): Set<number> {
  const dir = attackDir(team)
  const depth = (x: number) => (dir === 1 ? x : PITCH.width - x) // distance travelled toward the opponent goal
  const opp = caps.filter(c => c.team !== team).map(c => depth(c.x)).sort((a, b) => b - a)
  const secondLast = opp.length >= 2 ? opp[1] : -Infinity
  const out = new Set<number>()
  for (const c of caps) {
    if (c.team !== team || c.id === flickerId) continue
    const d = depth(c.x)
    if (d > PITCH.width / 2 && d > depth(ball.x) && d > secondLast) out.add(c.id)
  }
  return out
}

export type Whistle =
  | { kind: 'foul'; at: Vec; offender: TeamIndex; victimCap: number }
  | { kind: 'offside'; at: Vec; offender: TeamIndex; capId: number }

export interface ByLine { end: 0 | 1; lastTeam: TeamIndex; at: Vec }

export type Outcome =
  | { kind: 'normal'; next: TeamIndex }
  | { kind: 'bonus'; next: TeamIndex }
  | { kind: 'freekick'; next: TeamIndex; at: Vec; reason: 'freekick' | 'offside' }
  | { kind: 'penalty'; next: TeamIndex; end: 0 | 1 }
  | { kind: 'corner'; next: TeamIndex; end: 0 | 1; at: Vec }
  | { kind: 'goalkick'; next: TeamIndex; end: 0 | 1; at: Vec }
  /** Stuck ball: the ref drops it back into play at `at`. */
  | { kind: 'dropball'; next: TeamIndex; at: Vec }

export function outcomeReason(o: Outcome): TurnReason {
  switch (o.kind) {
    case 'normal': return 'normal'
    case 'bonus': return 'bonus'
    case 'freekick': return o.reason
    case 'penalty': return 'penalty'
    case 'corner': return 'corner'
    case 'goalkick': return 'goalkick'
    case 'dropball': return 'dropball'
  }
}

/** Persistent (cross-play) possession state: who touched the ball last and each team's pass chain. */
export interface Possession {
  lastCap: CapInfo | null
  chain: [number, number]
  powerReady: [boolean, boolean]
}

export function newPossession(): Possession {
  return { lastCap: null, chain: [0, 0], powerReady: [false, false] }
}

export type TrackerEvent =
  | { type: 'whistle'; whistle: Whistle }
  | { type: 'pass'; team: TeamIndex; chain: number; from: number; to: number }
  | { type: 'powerReady'; team: TeamIndex }
  | { type: 'boardBonus'; team: TeamIndex; capId: number }
  | { type: 'byline'; info: ByLine }
  | { type: 'boardHit'; at: Vec }

const capOf = (t: BodyTag): CapInfo | null => (t.kind === 'cap' ? t.cap : null)

/**
 * Follows a single play (one flick until everything settles) from contact events and
 * decides what the whistle says. Pure: no physics import, fully unit-testable.
 */
export class PlayTracker {
  readonly flicker: CapInfo
  private flickerTouchedBall: boolean
  private flickerFirstContactDone: boolean
  whistle: Whistle | null = null
  byline: ByLine | null = null
  private ballOffBoard = false
  bonus: { capId: number } | null = null
  private readonly offside: Set<number>
  readonly events: TrackerEvent[] = []

  constructor(
    flicker: CapInfo,
    private readonly rules: Ruleset,
    private readonly possession: Possession,
    opts: { touchingBallAtFlick: boolean; offsideAtFlick: Set<number> },
  ) {
    this.flicker = flicker
    this.flickerTouchedBall = opts.touchingBallAtFlick
    this.flickerFirstContactDone = opts.touchingBallAtFlick
    this.offside = rules.offside ? opts.offsideAtFlick : new Set()
    if (opts.touchingBallAtFlick) this.ballTouchedBy(flicker, { x: 0, y: 0 })
  }

  /** Drain events produced since the last call. */
  take(): TrackerEvent[] { return this.events.splice(0) }

  onContact(c: Contact): void {
    const a = c.a, b = c.b
    const at = { x: c.x, y: c.y }
    // Flicked cap's first contact with another cap decides fouls.
    const fa = capOf(a), fb = capOf(b)
    const flickerIn = fa?.id === this.flicker.id ? 'a' : fb?.id === this.flicker.id ? 'b' : null
    if (flickerIn && !this.flickerFirstContactDone) {
      const other = flickerIn === 'a' ? b : a
      if (other.kind === 'ball') this.flickerFirstContactDone = true
      else if (other.kind === 'cap') {
        this.flickerFirstContactDone = true
        if (other.cap.team !== this.flicker.team && !this.flickerTouchedBall && this.rules.freeKicks && !this.whistle && c.impact > 0.4) {
          this.blow({ kind: 'foul', at, offender: this.flicker.team, victimCap: other.cap.id })
        }
      }
    }
    // Ball contacts
    const ballWith = a.kind === 'ball' ? b : b.kind === 'ball' ? a : null
    if (!ballWith) return
    if (ballWith.kind === 'cap') {
      if (ballWith.cap.id === this.flicker.id) this.flickerTouchedBall = true
      this.ballTouchedBy(ballWith.cap, at)
    } else if (ballWith.kind === 'static') {
      const out = ballWith.board === 'byline' && this.rules.corners && c.impact >= this.rules.outMinImpact
      if (out && !this.byline && !this.whistle) {
        const last = this.possession.lastCap
        const by = this.rules.outBy === 'lastTouch' && last ? last.team : this.flicker.team
        this.byline = { end: ballWith.end as 0 | 1, lastTeam: by, at }
        this.events.push({ type: 'byline', info: this.byline })
      }
      if (ballWith.board === 'side' || (ballWith.board === 'byline' && !out)) {
        if (c.impact > 0.5) {
          this.ballOffBoard = true
          this.events.push({ type: 'boardHit', at })
        }
      }
    }
  }

  private ballTouchedBy(cap: CapInfo, at: Vec): void {
    const p = this.possession
    // Offside: ball reaches a team-mate who was offside when the flick was made.
    if (!this.whistle && cap.team === this.flicker.team && cap.id !== this.flicker.id && this.offside.has(cap.id)) {
      this.blow({ kind: 'offside', at, offender: cap.team, capId: cap.id })
    }
    // Board bonus: ball came off a board straight onto a cap of the flicking team.
    if (this.ballOffBoard) {
      this.ballOffBoard = false
      if (this.rules.boardBonus && cap.team === this.flicker.team && !this.bonus && !this.whistle) {
        this.bonus = { capId: cap.id }
        this.events.push({ type: 'boardBonus', team: cap.team, capId: cap.id })
      }
    }
    // Pass chains (persist across plays until the other team touches the ball).
    const last = p.lastCap
    if (last && last.team === cap.team && last.id !== cap.id) {
      if (this.rules.combos.enabled && !this.whistle) {
        p.chain[cap.team] += 1
        this.events.push({ type: 'pass', team: cap.team, chain: p.chain[cap.team], from: last.id, to: cap.id })
        if (p.chain[cap.team] >= this.rules.combos.passesForPowerShot && !p.powerReady[cap.team]) {
          p.powerReady[cap.team] = true
          p.chain[cap.team] = 0
          this.events.push({ type: 'powerReady', team: cap.team })
        }
      }
    } else if (last && last.team !== cap.team) {
      p.chain[last.team] = 0
    }
    p.lastCap = cap
  }

  private blow(w: Whistle): void {
    this.whistle = w
    this.events.push({ type: 'whistle', whistle: w })
  }

  /** Called once everything has settled (and no goal was scored). */
  resolve(): Outcome {
    const team = this.flicker.team
    const w = this.whistle
    if (w) {
      const victim = otherTeam(w.offender)
      if (w.kind === 'foul') {
        const defendedEnd: 0 | 1 = w.offender === 0 ? 0 : 1
        if (this.rules.penalties && inPenaltyBox(w.at, defendedEnd)) return { kind: 'penalty', next: victim, end: defendedEnd }
        return { kind: 'freekick', next: victim, at: w.at, reason: 'freekick' }
      }
      return { kind: 'freekick', next: victim, at: w.at, reason: 'offside' }
    }
    if (this.byline) {
      const { end, lastTeam, at } = this.byline
      const defender = defendingTeam(end)
      if (lastTeam === defender) return { kind: 'corner', next: otherTeam(defender), end, at }
      return { kind: 'goalkick', next: defender, end, at }
    }
    if (this.bonus) return { kind: 'bonus', next: team }
    return { kind: 'normal', next: otherTeam(team) }
  }
}

export function inPenaltyBox(p: Vec, end: 0 | 1): boolean {
  const { depth, width } = PITCH.penaltyBox
  const top = (PITCH.height - width) / 2
  const inY = p.y >= top && p.y <= top + width
  return inY && (end === 0 ? p.x <= depth : p.x >= PITCH.width - depth)
}
