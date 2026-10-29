/**
 * CAPBALL AI opponent.
 *
 * On its turn the AI copies the current board into a hidden Match (same physics, same ruleset, same surface),
 * rehearses candidate flicks there all the way to the settle, scores the outcome, then plays the best one with
 * human-like aim and power error. Nothing here touches the DOM; it runs headless in tests.
 *
 * Rehearsals are exact for this engine (same code, same floats), so difficulty comes from how many candidates it
 * rehearses and how much execution error it adds — not from secretly weaker physics.
 */
import { AI, BALL, CAP_TYPES, LINEUP, PITCH, PLAIN_LINEUP } from '../config/tuning'
import type { AiLevel, AiLevelConfig, CapTypeId, SurfaceId } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'
import { Match } from '../game/match'
import type { Possession } from '../game/play'
import type { TurnReason } from '../game/turns'
import type { TeamIndex, Vec } from '../physics/world'

const W = PITCH.width
const H = PITCH.height

export interface BoardCap { x: number; y: number; angle: number; active: boolean }
/** Everything the AI needs to rebuild the current position. Plain data (structured-clone safe). */
export interface BoardState {
  caps: BoardCap[]
  ball: Vec
  team: TeamIndex
  reason: TurnReason
  possession: Possession
  /** Caps the AI may flick right now (shootout restricts this to the taker). */
  pickable: number[]
  shootout: boolean
}

export interface Candidate { capId: number; dir: Vec; power: number; spin: number; arm: boolean; kind: CandidateKind }
export type CandidateKind = 'shot' | 'pass' | 'clear' | 'block' | 'nudge'
export interface Decision extends Candidate { score: number; rehearsed: number; label: string }

/** Small seeded RNG so tests are reproducible; the app seeds from Math.random. */
export function makeRng(seed: number): () => number {
  let s = (Math.floor(seed * 2147483646) % 2147483646) + 1
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}
const gauss = (rng: () => number) => {
  const u = Math.max(1e-9, rng())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** Read the board from a live match. */
export function captureBoard(m: Match): BoardState {
  return {
    caps: m.world.caps.map(b => ({ x: b.position.x, y: b.position.y, angle: b.angle, active: m.world.isActive(b) })),
    ball: { x: m.world.ball.position.x, y: m.world.ball.position.y },
    team: m.team,
    reason: m.reason,
    possession: structuredClone(m.possession),
    pickable: m.world.caps.map((_, i) => i).filter(i => m.canPick(i)),
    shootout: !!m.shootout,
  }
}

/** Opponent goal centre for `team` (team 0 attacks the right-hand goal). */
const theirGoal = (team: TeamIndex): Vec => ({ x: team === 0 ? W : 0, y: H / 2 })
const ourGoal = (team: TeamIndex): Vec => ({ x: team === 0 ? 0 : W, y: H / 2 })
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)
const unit = (v: Vec): Vec => { const d = Math.hypot(v.x, v.y) || 1; return { x: v.x / d, y: v.y / d } }
const rotate = (v: Vec, a: number): Vec => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })

export class AiBrain {
  readonly level: AiLevelConfig
  private readonly rng: () => number
  private readonly lineup: CapTypeId[]

  constructor(readonly ruleset: Ruleset, readonly surface: SurfaceId, readonly levelId: AiLevel, seed = Math.random()) {
    this.level = AI.levels[levelId]
    this.rng = makeRng(seed)
    this.lineup = ruleset.capTypes ? LINEUP : PLAIN_LINEUP
  }

  /** Candidate flicks for this board, most promising first. */
  candidates(b: BoardState): Candidate[] {
    const me = b.team
    const out: Candidate[] = []
    const goal = theirGoal(me)
    const home = ourGoal(me)
    const ballR = BALL.radius
    const caps = b.pickable
      .map(id => ({ id, p: b.caps[id], r: this.radius(b, id) }))
      .sort((a, c) => dist(a.p, b.ball) - dist(c.p, b.ball))
    const canArm = this.level.usePowerShot && b.possession.powerReady[me] && !b.shootout
    const gw = PITCH.goalWidth / 2
    // Aim points on the goal: centre and inside each post (the shootout aims for the corners).
    const goalTargets: Vec[] = b.shootout
      ? [{ x: goal.x, y: H / 2 - gw * 0.72 }, { x: goal.x, y: H / 2 + gw * 0.72 }, { x: goal.x, y: H / 2 - gw * 0.45 }, { x: goal.x, y: H / 2 + gw * 0.45 }]
      : [goal, { x: goal.x, y: H / 2 - gw * 0.55 }, { x: goal.x, y: H / 2 + gw * 0.55 }]
    // Ghost-ball aiming: hit the ball's far side so it travels toward `target`.
    const ghostDir = (cap: { p: Vec; r: number }, target: Vec): Vec | null => {
      const toT = unit({ x: target.x - b.ball.x, y: target.y - b.ball.y })
      const ghost = { x: b.ball.x - toT.x * (cap.r + ballR), y: b.ball.y - toT.y * (cap.r + ballR) }
      const d = { x: ghost.x - cap.p.x, y: ghost.y - cap.p.y }
      if (Math.hypot(d.x, d.y) < 2) return unit({ x: b.ball.x - cap.p.x, y: b.ball.y - cap.p.y })
      const u = unit(d)
      // The cap must be roughly behind the ball relative to the target, or the cut is impossible.
      const cut = u.x * toT.x + u.y * toT.y
      return cut > 0.15 ? u : null
    }
    const powers = b.shootout ? [0.75, 0.9, 1] : [0.5, 0.75, 1]
    for (const cap of caps.slice(0, b.shootout ? 1 : 4)) {
      for (const t of goalTargets) {
        const d = ghostDir(cap, t)
        if (!d) continue
        for (const p of powers) {
          out.push({ capId: cap.id, dir: d, power: p, spin: 0, arm: false, kind: 'shot' })
          if (canArm && p >= 0.75 && dist(b.ball, goal) < 520) out.push({ capId: cap.id, dir: d, power: p, spin: 0, arm: true, kind: 'shot' })
        }
      }
      if (b.shootout) continue
      // Passes into space ahead of a team-mate, clearances to the side boards.
      for (const mate of caps) {
        if (mate.id === cap.id) continue
        const ahead = { x: mate.p.x + (goal.x - mate.p.x) * 0.25, y: mate.p.y }
        const d = ghostDir(cap, ahead)
        if (d) out.push({ capId: cap.id, dir: d, power: 0.55, spin: 0, arm: false, kind: 'pass' })
      }
      for (const sideY of [ballR + 10, H - ballR - 10]) {
        const d = ghostDir(cap, { x: b.ball.x + (goal.x - b.ball.x) * 0.35, y: sideY })
        if (d) out.push({ capId: cap.id, dir: d, power: 0.85, spin: 0, arm: false, kind: 'clear' })
      }
      // A soft nudge straight through the ball.
      out.push({ capId: cap.id, dir: unit({ x: b.ball.x - cap.p.x, y: b.ball.y - cap.p.y }), power: 0.35, spin: 0, arm: false, kind: 'nudge' })
    }
    if (!b.shootout) {
      // Block: slide a cap into the lane between the ball and our goal (no ball contact intended).
      const lane = { x: (b.ball.x + home.x) / 2, y: (b.ball.y + home.y) / 2 }
      for (const cap of caps.slice(1, 4)) {
        const d = { x: lane.x - cap.p.x, y: lane.y - cap.p.y }
        if (Math.hypot(d.x, d.y) > 40) for (const p of [0.3, 0.45]) out.push({ capId: cap.id, dir: unit(d), power: p, spin: 0, arm: false, kind: 'block' })
      }
    }
    // Shots first (they're what the AI most wants to know about), then the rest shuffled.
    const shots = out.filter(c => c.kind === 'shot')
    const rest = out.filter(c => c.kind !== 'shot')
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
    return [...shots, ...rest]
  }

  private radius(b: BoardState, id: number): number {
    const slot = id % 5
    const type: CapTypeId = this.ruleset.capTypes || b.shootout ? LINEUP[slot] : this.lineup[slot]
    return CAP_TYPES[type].radius
  }

  /**
   * Rehearse one candidate in a fresh hidden match and score the result for `b.team`.
   * The hidden match is created and destroyed here, so nothing leaks between rehearsals.
   */
  rehearse(b: BoardState, c: Candidate): number {
    const me = b.team
    const rules: Ruleset = b.shootout ? { ...this.ruleset, capTypes: true, freeKicks: false, corners: false, offside: false } : this.ruleset
    const m = new Match({ ruleset: rules, surface: this.surface })
    try {
      m.world.caps.forEach((body, i) => {
        const s = b.caps[i]
        m.world.setActive(body, s.active)
        if (s.active) m.world.place(body, { x: s.x, y: s.y }, s.angle)
      })
      m.world.place(m.world.ball, b.ball)
      m.possession = structuredClone(b.possession)
      m.turns.startTurn(me, b.shootout ? 'normal' : b.reason)
      if (c.arm && m.canArm(me)) m.toggleArm()
      let scorer: TeamIndex | null = null
      let next: { team: TeamIndex; reason: TurnReason } | null = null
      const offGoal = m.events.on('goal', g => { scorer = g.scorer })
      const offTurn = m.events.on('turn', t => { next = t })
      if (!m.tryFlick(c.capId, c.dir, c.power, c.spin)) return -Infinity
      const frame = 1000 / 60
      for (let t = 0; t < AI.rehearsalMaxMs; t += frame) {
        m.update(frame)
        if (scorer !== null || next) break
        if (m.phase === 'reset') m.completeTween()
      }
      offGoal(); offTurn()
      return this.evaluate(m, me, scorer, next)
    } finally {
      m.destroy()
    }
  }

  /** Points for `me` given where the rehearsal ended. */
  evaluate(m: Match, me: TeamIndex, scorer: TeamIndex | null, next: { team: TeamIndex; reason: TurnReason } | null): number {
    const w = AI.weights
    if (scorer !== null) return scorer === me ? w.goal : -w.goal
    let s = 0
    if (next) {
      const mine = next.team === me
      switch (next.reason) {
        case 'bonus': s += mine ? w.bonus : 0; break
        case 'corner': s += mine ? w.cornerFor : -w.cornerAgainst; break
        case 'penalty': s += mine ? w.penaltyAgainst * 0.6 : -w.penaltyAgainst; break
        case 'freekick': s += mine ? w.freeKickAgainst * 0.5 : -w.freeKickAgainst; break
        case 'offside': s += mine ? 0 : -w.offside; break
        case 'goalkick': s += mine ? 0 : -w.goalKickAgainst; break
      }
    }
    const ball = m.world.ball.position
    const them: TeamIndex = me === 0 ? 1 : 0
    s += w.ballNearTheirGoal * Math.max(0, 1 - dist(ball, theirGoal(me)) / W)
    s -= w.ballNearOurGoal * Math.max(0, 1 - dist(ball, ourGoal(me)) / W) ** 1.5
    // Who is closest to the ball next turn?
    let mineNear = Infinity
    let theirNear = Infinity
    m.world.caps.forEach((body, i) => {
      if (!m.world.isActive(body)) return
      const d = dist(body.position, ball)
      if (m.world.capInfo(i).team === me) mineNear = Math.min(mineNear, d)
      else theirNear = Math.min(theirNear, d)
    })
    if (Number.isFinite(mineNear) && Number.isFinite(theirNear)) s += w.control * Math.max(-1, Math.min(1, (theirNear - mineNear) / 220))
    // Whoever moves next with the ball near our goal is a threat; worse if it is them.
    if (next && next.team === them) s -= w.ballNearOurGoal * 0.5 * Math.max(0, 1 - dist(ball, ourGoal(me)) / (W * 0.45))
    // Keep the keeper at home.
    const keeper = m.world.caps[me === 0 ? 0 : 5]
    if (keeper && m.world.isActive(keeper)) s -= w.keeperOffLine * Math.max(0, dist(keeper.position, ourGoal(me)) - 70)
    return s
  }

  /**
   * Pick a flick. Yields to the caller between rehearsals (`await`), so the page keeps animating.
   * `isCancelled` lets the app abandon a decision on restart / new match.
   */
  async decide(b: BoardState, isCancelled: () => boolean = () => false, yieldEvery = 3): Promise<Decision | null> {
    const pool = this.candidates(b).slice(0, this.level.candidates)
    if (!pool.length) return null
    let best: Decision | null = null
    let n = 0
    const consider = (c: Candidate, score: number) => {
      // A touch of judgement noise so equal-ish options don't always resolve the same way.
      const jitter = (this.rng() - 0.5) * 30
      if (!best || score + jitter > best.score) best = { ...c, score: score + jitter, rehearsed: n, label: c.kind }
    }
    for (const c of pool) {
      if (isCancelled()) return null
      consider(c, this.rehearse(b, c))
      n++
      if (n % yieldEvery === 0) await new Promise<void>(r => setTimeout(r, 0))
    }
    // Hard AI: try bending the best few with spin.
    if (this.level.trySpin && this.ruleset.spin && best) {
      const base: Decision = best
      for (const spin of [-0.7, 0.7]) {
        for (const da of [-0.06, 0.06]) {
          if (isCancelled()) return null
          const c: Candidate = { ...base, dir: rotate(base.dir, da), spin }
          consider(c, this.rehearse(b, c))
          n++
        }
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
    if (!best) return null
    const chosen: Decision = best
    chosen.rehearsed = n
    return this.execute(chosen)
  }

  /** Add human-like execution error to a decision. */
  execute(d: Decision): Decision {
    const ang = gauss(this.rng) * this.level.aimNoise
    const power = Math.max(0.12, Math.min(1, d.power * (1 + gauss(this.rng) * this.level.powerNoise)))
    return { ...d, dir: rotate(d.dir, ang), power }
  }

  /** Shootout keeper: a guess along the line, biased to the middle. */
  keeperGuess(): number {
    const half = PITCH.goalWidth / 2 - CAP_TYPES.keeper.radius
    return H / 2 + Math.max(-1, Math.min(1, gauss(this.rng) * 0.45)) * half
  }
}
