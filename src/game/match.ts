import { BALL, CAP_TYPES, FX, INPUT, LINEUP, PHYSICS, PITCH, PLAIN_LINEUP } from '../config/tuning'
import type { CapTypeId, SurfaceId } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'
import { PhysicsWorld } from '../physics/world'
import type { Contact, PhysicsSnapshot, TeamIndex, Vec } from '../physics/world'
import { SettleDetector } from '../physics/settle'
import { Emitter } from './emitter'
import { CENTER, kickoffPosition } from './formation'
import { DeadBallWatch, dropSpot } from './deadball'
import { PlayTracker, newPossession, offsideCaps, outcomeReason } from './play'
import type { Outcome, Possession, TrackerEvent, Whistle } from './play'
import { GoalLatch, addGoal, goalTargetWinner, otherTeam, timeWinner } from './rules'
import type { ScoreState } from './rules'
import { setPieceTargets } from './setpieces'
import { ShootoutScore } from './shootout'
import { TurnMachine } from './turns'
import type { Phase, TurnReason } from './turns'

export interface MatchOptions {
  ruleset: Ruleset
  surface: SurfaceId
  firstTeam?: TeamIndex
  /** Penalty shootout instead of open play. */
  shootout?: { first: TeamIndex; rounds?: number }
}

export interface AuthoritativeMatchState {
  bodies: PhysicsSnapshot
  phase: Phase
  team: TeamIndex
  reason: TurnReason
  turn: number
  flicks: number
  score: [number, number]
  possession: { chain: [number, number]; powerReady: [boolean, boolean]; lastCap: number | null }
  armed: TeamIndex | null
  activeCap: number | null
}

export type MatchEvents = {
  contact: Contact
  flick: { capId: number; team: TeamIndex; power: number; powerShot: boolean; spin: number; speed: number }
  goal: { scorer: TeamIndex; end: 0 | 1; ownGoal: boolean; score: ScoreState; capId: number | null }
  turn: { team: TeamIndex; reason: TurnReason }
  phase: { phase: Phase }
  win: { team: TeamIndex | null; score: ScoreState; reason: 'target' | 'time' | 'shootout' }
  kick: { team: TeamIndex; scored: boolean; saved: boolean; tally: [boolean[], boolean[]] }
  settled: { playMs: number }
  whistle: Whistle | { kind: 'dropball'; at: Vec }
  play: TrackerEvent
  half: { half: number; of: number }
  /** Fired every fixed step while bodies move (dust, trails). */
  step: { dtMs: number }
}

interface Tween {
  from: Vec[]
  to: Vec[]
  t: number
  dur: number
  then: () => void
}

/**
 * The match orchestrator. Owns the physics world and drives it with a fixed timestep,
 * runs the turn machine and the rules, and reports everything through events.
 * No DOM/canvas/audio dependencies — tests drive it directly.
 */
export class Match {
  readonly events = new Emitter<MatchEvents>()
  readonly world: PhysicsWorld
  readonly turns = new TurnMachine(0)
  readonly ruleset: Ruleset
  score: ScoreState = { goals: [0, 0] }
  /** Real-time multiplier (slow motion). */
  timeScale = 1
  /** When true nothing advances (menus open). */
  paused = false
  possession: Possession = newPossession()
  /** Team that armed its power shot for the next flick. */
  armed: TeamIndex | null = null
  /** Clock: ms played in the current half (only runs during live turns). */
  clockMs = 0
  half = 1
  play: PlayTracker | null = null
  /** Cap flicked in the current play (renderer trail). */
  activeCap: number | null = null
  powerShotLive = false
  private accumulator = 0
  private readonly latch = new GoalLatch()
  private readonly settle = new SettleDetector()
  private tween: Tween | null = null
  private phaseTimer = 0
  private kickoffTeam: TeamIndex
  private lastScorer: TeamIndex = 0
  private timeUp = false
  private unsubContact: () => void
  private destroyed = false
  /** Hook for replay: set by the app; called after each fixed step while recording. */
  onFixedStep: (() => void) | null = null
  /** Hook: app may hold the goal phase (replay) and later call finishGoal(). */
  holdAfterGoal = false
  /** Shootout state (null in open play). */
  shootout: ShootoutScore | null = null
  takerId = -1
  keeperId = -1
  private keeperTouched = false
  private readonly deadBall: DeadBallWatch
  private ballAtFlick: Vec = { x: 0, y: 0 }

  constructor(readonly options: MatchOptions) {
    this.ruleset = options.ruleset
    this.deadBall = new DeadBallWatch(options.shootout ? 0 : options.ruleset.deadBallTurns)
    const lineup: CapTypeId[] = options.ruleset.capTypes || options.shootout ? LINEUP : PLAIN_LINEUP
    this.world = new PhysicsWorld([lineup, lineup], options.surface)
    this.kickoffTeam = options.firstTeam ?? 0
    this.unsubContact = this.world.onContact(c => this.onContact(c))
    if (options.shootout) {
      this.shootout = new ShootoutScore(options.shootout.first, options.shootout.rounds ?? 5)
      this.setupKick(true)
    } else {
      this.placeKickoff(this.kickoffTeam)
      this.turns.reset(this.kickoffTeam)
    }
  }

  get phase(): Phase { return this.turns.state.phase }
  get team(): TeamIndex { return this.turns.state.team }
  get reason(): TurnReason { return this.turns.state.reason }
  /** Correct this client-side prediction from the room's authoritative Matter snapshot. */
  applyAuthoritativeState(state: AuthoritativeMatchState): void {
    const phaseChanged = this.phase !== state.phase
    this.world.restore(state.bodies)
    this.score = { goals: [...state.score] }
    this.possession = {
      chain: [...state.possession.chain],
      powerReady: [...state.possession.powerReady],
      lastCap: state.possession.lastCap === null ? null : this.world.capInfo(state.possession.lastCap),
    }
    this.armed = state.armed
    this.activeCap = state.activeCap
    this.turns.state = { phase: state.phase, team: state.team, reason: state.reason, turn: state.turn, flicks: state.flicks }
    if (phaseChanged) {
      this.latch.reset()
      this.settle.reset()
      this.tween = null
      this.phaseTimer = 0
      this.accumulator = 0
      this.timeScale = 1
      this.events.emit('phase', { phase: state.phase })
    }
  }
  get halfSeconds(): number | null { return this.ruleset.halves?.seconds ?? null }
  /** Remaining time in the half (s), or null when untimed. */
  get timeLeft(): number | null {
    const s = this.halfSeconds
    return s == null ? null : Math.max(0, s - this.clockMs / 1000)
  }

  /** Advance by real frame time. Physics only ever moves in fixed steps. */
  update(frameMs: number): void {
    if (this.destroyed || this.paused) return
    const real = Math.min(frameMs, 100)
    const dt = real * this.timeScale
    const phase = this.phase
    if ((phase === 'aim' || phase === 'moving') && this.ruleset.halves) {
      this.clockMs += real
      if (!this.timeUp && this.timeLeft === 0) this.timeUp = true
      if (this.timeUp && phase === 'aim') { this.endHalf(); return }
    }
    if (phase === 'reset') { this.advanceTween(dt); return }
    if (phase === 'moving' || phase === 'goal') {
      this.accumulator += dt
      let steps = 0
      while (this.accumulator >= this.world.stepMs && steps < PHYSICS.maxStepsPerFrame) {
        this.accumulator -= this.world.stepMs
        steps++
        this.fixedStep()
        if (this.phase !== 'moving' && this.phase !== 'goal') { this.accumulator = 0; break }
      }
      if (steps >= PHYSICS.maxStepsPerFrame) this.accumulator = 0
      if (steps) this.events.emit('step', { dtMs: steps * this.world.stepMs })
    }
    if (this.phase === 'goal' && !this.holdAfterGoal) {
      this.phaseTimer += real
      if (this.phaseTimer >= FX.celebrateMs) this.finishGoal()
    }
  }

  canArm(team: TeamIndex): boolean {
    return this.possession.powerReady[team] && this.phase === 'aim' && this.team === team
  }

  toggleArm(): boolean {
    if (!this.canArm(this.team)) return false
    this.armed = this.armed === this.team ? null : this.team
    return true
  }

  /** Can this cap be grabbed right now (team on turn, mode restrictions)? */
  canPick(capId: number): boolean {
    if (this.phase !== 'aim') return false
    const body = this.world.caps[capId]
    if (!body || !this.world.isActive(body)) return false
    if (this.world.capInfo(capId).team !== this.team) return false
    if (this.shootout) return this.reason === 'keeper' ? capId === this.keeperId : capId === this.takerId
    return true
  }

  /** Shootout: the keeper is being positioned along the line (no physics; between kicks). */
  get keeperSetting(): boolean { return !!this.shootout && this.phase === 'aim' && this.reason === 'keeper' }

  slideKeeper(y: number): void {
    if (!this.keeperSetting) return
    const r = CAP_TYPES.keeper.radius
    const top = (PITCH.height - PITCH.goalWidth) / 2 + r - 4
    const bottom = (PITCH.height + PITCH.goalWidth) / 2 - r + 4
    const k = this.world.caps[this.keeperId]
    this.world.place(k, { x: PITCH.width - r - 3, y: Math.max(top, Math.min(bottom, y)) })
  }

  keeperReady(): void {
    if (!this.keeperSetting || !this.shootout) return
    const kicker = this.shootout.kicker
    this.turns.startTurn(kicker, 'shootout')
    this.events.emit('turn', { team: kicker, reason: 'shootout' })
  }

  /**
   * Attempt a flick. `power` is 0..1 (already clamped by input).
   * `spin` is -1..1 (+ = clockwise on screen); ignored when the ruleset has spin off.
   */
  tryFlick(capId: number, dir: Vec, power: number, spin = 0): boolean {
    if (this.paused) return false
    const body = this.world.caps[capId]
    if (!body || !this.world.isActive(body)) return false
    if (!this.canPick(capId) || this.keeperSetting) return false
    const info = this.world.capInfo(capId)
    if (!this.turns.flick(info.team)) return false
    const p = Math.max(0, Math.min(1, power))
    const powerShot = this.armed === info.team && this.possession.powerReady[info.team]
    const mult = powerShot ? this.ruleset.combos.powerMultiplier : 1
    if (powerShot) { this.possession.powerReady[info.team] = false; this.armed = null }
    this.powerShotLive = powerShot
    const impulse = INPUT.maxImpulse * Math.pow(p, INPUT.powerCurve) * mult
    // Snapshot for offside + "already touching the ball" before anything moves.
    const ball = this.world.ball.position
    const capR = info.type.radius
    const touching = Math.hypot(body.position.x - ball.x, body.position.y - ball.y) <= capR + BALL.radius + 1.5
    const caps = this.world.caps.filter(b => this.world.isActive(b)).map(b => {
      const ci = this.world.capInfo(this.world.caps.indexOf(b))
      return { id: ci.id, team: ci.team, x: b.position.x, y: b.position.y }
    })
    this.play = this.shootout ? null : new PlayTracker(info, this.ruleset, this.possession, {
      touchingBallAtFlick: touching,
      offsideAtFlick: offsideCaps(info.team, caps, ball, capId),
    })
    this.keeperTouched = false
    this.world.brake = 1
    const s = this.ruleset.spin ? Math.max(-1, Math.min(1, spin)) : 0
    this.ballAtFlick = { x: ball.x, y: ball.y }
    this.world.flick(capId, dir, impulse, s * INPUT.maxSpin)
    this.activeCap = capId
    this.latch.reset()
    this.settle.reset()
    this.accumulator = 0
    this.events.emit('flick', { capId, team: info.team, power: p, powerShot, spin: s, speed: body.speed })
    this.events.emit('phase', { phase: 'moving' })
    this.drainPlay()
    return true
  }

  /** Same teams, same settings, score back to 0-0. */
  restart(): void {
    this.score = { goals: [0, 0] }
    this.tween = null
    this.timeScale = 1
    this.paused = false
    this.accumulator = 0
    this.clockMs = 0
    this.half = 1
    this.timeUp = false
    this.possession = newPossession()
    this.armed = null
    this.play = null
    this.activeCap = null
    this.powerShotLive = false
    this.latch.reset()
    this.settle.reset()
    this.holdAfterGoal = false
    this.deadBall.reset()
    this.kickoffTeam = this.options.firstTeam ?? 0
    if (this.shootout) {
      this.shootout = new ShootoutScore(this.shootout.first, this.shootout.rounds)
      this.setupKick(true)
      this.events.emit('phase', { phase: 'aim' })
      this.events.emit('turn', { team: this.team, reason: 'keeper' })
      return
    }
    this.turns.reset(this.kickoffTeam)
    this.placeKickoff(this.kickoffTeam)
    this.events.emit('phase', { phase: 'aim' })
    this.events.emit('turn', { team: this.kickoffTeam, reason: 'kickoff' })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubContact()
    this.events.clear()
    this.world.destroy()
  }

  // ---------------------------------------------------------------- internals
  private onContact(c: Contact): void {
    this.events.emit('contact', c)
    if (this.shootout && this.phase === 'moving') {
      const capHit = c.a.kind === 'cap' ? c.a.cap : c.b.kind === 'cap' ? c.b.cap : null
      if ((c.a.kind === 'ball' || c.b.kind === 'ball') && capHit?.id === this.keeperId) this.keeperTouched = true
    }
    if (this.phase === 'moving' && this.play) {
      this.play.onContact(c)
      this.drainPlay()
    }
  }

  private drainPlay(): void {
    if (!this.play) return
    for (const e of this.play.take()) {
      this.events.emit('play', e)
      if (e.type === 'whistle') {
        this.latch.lock() // play is dead: nothing after the whistle counts
        this.world.brake = 3 // let things come to rest a little faster (same single friction pass)
        this.events.emit('whistle', e.whistle)
      }
    }
  }

  private fixedStep(): void {
    this.world.step()
    this.onFixedStep?.()
    if (this.phase !== 'moving') return
    const ball = this.world.ball
    const g = this.latch.check(ball.position.x, ball.position.y, BALL.radius)
    if (g) {
      if (this.shootout) {
        const kicker = this.shootout.kicker
        this.turns.goal()
        this.phaseTimer = 0
        this.recordKick(g.end === 1)
        this.events.emit('goal', { scorer: kicker, end: g.end, ownGoal: false, score: this.score, capId: this.takerId })
        this.events.emit('phase', { phase: 'goal' })
        return
      }
      this.score = addGoal(this.score, g.scorer)
      this.lastScorer = g.scorer
      this.turns.goal()
      this.phaseTimer = 0
      const last = this.possession.lastCap
      const ownGoal = last !== null && last.team !== g.scorer
      this.possession = newPossession() // chains reset after a goal; charged shots too
      this.armed = null
      this.events.emit('goal', { scorer: g.scorer, end: g.end, ownGoal, score: this.score, capId: last?.id ?? null })
      this.events.emit('phase', { phase: 'goal' })
      return
    }
    const playMs = this.settle.playMs
    if (playMs > PHYSICS.maxPlayMs) this.world.brake = Math.max(this.world.brake, 1 + (playMs - PHYSICS.maxPlayMs) / 1000)
    if (this.settle.update(this.world.isAtRest(), this.world.stepMs)) this.onSettled()
  }

  private onSettled(): void {
    this.events.emit('settled', { playMs: this.settle.playMs })
    this.world.brake = 1
    this.activeCap = null
    this.powerShotLive = false
    if (this.shootout) {
      this.turns.enter('reset')
      this.recordKick(false)
      this.afterKick()
      return
    }
    let outcome: Outcome = this.play ? this.play.resolve() : { kind: 'normal', next: otherTeam(this.team) }
    this.play = null
    // Stuck ball: pinned against the boards and unmoved for N plays → the ref drops it back in.
    const ballNow = { x: this.world.ball.position.x, y: this.world.ball.position.y }
    const circles = this.world.caps.filter(b => this.world.isActive(b)).map(b => ({ x: b.position.x, y: b.position.y, r: (b.circleRadius ?? 22) }))
    const stuck = this.deadBall.afterPlay(this.ballAtFlick, ballNow, circles)
    if (outcome.kind === 'normal' || outcome.kind === 'bonus') {
      if (stuck) {
        outcome = { kind: 'dropball', next: outcome.next, at: dropSpot(ballNow) }
        this.events.emit('whistle', { kind: 'dropball', at: outcome.at })
      }
    } else this.deadBall.reset()
    if (this.armed !== null && this.armed !== outcome.next) this.armed = null
    if (outcome.kind !== 'normal' && outcome.kind !== 'bonus') {
      // Set pieces break passing chains.
      this.possession.chain = [0, 0]
      this.possession.lastCap = null
    }
    if (this.timeUp) {
      this.turns.settled(outcome.next, outcomeReason(outcome))
      this.endHalf()
      return
    }
    const targets = setPieceTargets(outcome, this.pieceCaps(), this.world.ball.position, this.ruleset)
    const reason = outcomeReason(outcome)
    if (!targets) {
      this.turns.settled(outcome.next, reason)
      this.events.emit('phase', { phase: 'aim' })
      this.events.emit('turn', { team: outcome.next, reason })
      return
    }
    this.turns.settled(outcome.next, reason) // leave 'moving'
    this.turns.enter('reset')
    this.events.emit('phase', { phase: 'reset' })
    this.startTween([...targets.caps, targets.ball], () => {
      this.turns.startTurn(outcome.next, reason)
      this.events.emit('phase', { phase: 'aim' })
      this.events.emit('turn', { team: outcome.next, reason })
    })
  }

  private pieceCaps() {
    return this.world.caps.map((b, id) => {
      const i = this.world.capInfo(id)
      return { id, team: i.team, slot: i.slot, type: i.type.id, x: b.position.x, y: b.position.y, active: this.world.isActive(b) }
    })
  }

  /** End the goal celebration (or the replay) and carry on. */
  finishGoal(): void {
    if (this.phase !== 'goal' && this.phase !== 'replay') return
    this.holdAfterGoal = false
    this.timeScale = 1
    if (this.shootout) { this.afterKick(); return }
    const winner = goalTargetWinner(this.score, this.ruleset)
    if (winner !== null) {
      this.turns.finish()
      this.events.emit('phase', { phase: 'over' })
      this.events.emit('win', { team: winner, score: this.score, reason: 'target' })
      return
    }
    if (this.timeUp) { this.endHalf(); return }
    // Conceding team kicks off.
    this.kickoffTeam = otherTeam(this.lastScorer)
    this.resetToKickoff(this.kickoffTeam, 'kickoff')
  }

  /** App-driven slow-motion replay sits between the goal and the restart. */
  enterReplay(): void {
    if (this.phase !== 'goal') return
    this.turns.enter('replay')
    this.events.emit('phase', { phase: 'replay' })
  }

  // ---------------------------------------------------------------- shootout
  private recordKick(scored: boolean): void {
    const so = this.shootout!
    const team = so.kicker
    so.record(scored)
    this.score = { goals: [so.goals(0), so.goals(1)] }
    this.events.emit('kick', { team, scored, saved: !scored && this.keeperTouched, tally: [[...so.kicks[0]], [...so.kicks[1]]] })
  }

  private afterKick(): void {
    const so = this.shootout!
    if (so.winner !== null) {
      this.turns.finish()
      this.events.emit('phase', { phase: 'over' })
      this.events.emit('win', { team: so.winner, score: this.score, reason: 'shootout' })
      return
    }
    this.turns.enter('reset')
    this.events.emit('phase', { phase: 'reset' })
    this.setupKick(false)
  }

  /** Taker behind the spot, keeper on the line, everyone else on the bench. Always the right-hand goal. */
  private setupKick(immediate: boolean): void {
    const so = this.shootout!
    const kicker = so.kicker
    const keeperTeam = otherTeam(kicker)
    this.takerId = kicker * 5 + so.takerSlot(kicker)
    this.keeperId = keeperTeam * 5
    this.world.caps.forEach((b, id) => this.world.setActive(b, id === this.takerId || id === this.keeperId))
    const spot = { x: PITCH.width - PITCH.penaltySpot, y: PITCH.height / 2 }
    const takerR = this.world.capInfo(this.takerId).type.radius
    const keeperR = this.world.capInfo(this.keeperId).type.radius
    const targets: Vec[] = this.world.caps.map(b => ({ x: b.position.x, y: b.position.y }))
    targets[this.takerId] = { x: spot.x - (BALL.radius + takerR + 34), y: spot.y }
    targets[this.keeperId] = { x: PITCH.width - keeperR - 3, y: spot.y }
    targets.push(spot)
    this.latch.reset()
    const start = () => {
      this.turns.startTurn(keeperTeam, 'keeper')
      if (!immediate) {
        this.events.emit('phase', { phase: 'aim' })
        this.events.emit('turn', { team: keeperTeam, reason: 'keeper' })
      }
    }
    if (immediate) {
      ;[...this.world.caps, this.world.ball].forEach((b, i) => this.world.place(b, targets[i], 0))
      this.turns.reset(keeperTeam)
      start()
    } else {
      this.startTween(targets, start)
    }
  }

  private endHalf(): void {
    const halves = this.ruleset.halves
    this.timeUp = false
    if (!halves || this.half >= halves.count) {
      this.turns.finish()
      this.events.emit('phase', { phase: 'over' })
      this.events.emit('win', { team: timeWinner(this.score), score: this.score, reason: 'time' })
      return
    }
    this.half += 1
    this.clockMs = 0
    this.possession = newPossession()
    this.armed = null
    this.events.emit('half', { half: this.half, of: halves.count })
    // Second half: the other team kicks off.
    const team = otherTeam(this.options.firstTeam ?? 0)
    this.kickoffTeam = team
    this.resetToKickoff(team, 'halftime')
  }

  private resetToKickoff(team: TeamIndex, reason: TurnReason): void {
    this.turns.enter('reset')
    this.events.emit('phase', { phase: 'reset' })
    this.startTween(this.kickoffTargets(team), () => {
      this.turns.startTurn(team, reason)
      this.events.emit('phase', { phase: 'aim' })
      this.events.emit('turn', { team, reason })
    })
  }

  private kickoffTargets(team: TeamIndex): Vec[] {
    const t: Vec[] = this.world.caps.map((_, id) => {
      const info = this.world.capInfo(id)
      return kickoffPosition(info.team, info.slot, team)
    })
    t.push({ ...CENTER })
    return t
  }

  private placeKickoff(team: TeamIndex): void {
    const t = this.kickoffTargets(team)
    this.world.caps.forEach((b, i) => this.world.place(b, t[i], 0))
    this.world.place(this.world.ball, t[t.length - 1], 0)
  }

  private startTween(to: Vec[], then: () => void): void {
    const bodies = [...this.world.caps, this.world.ball]
    for (const b of bodies) this.world.place(b, b.position)
    this.tween = { from: bodies.map(b => ({ x: b.position.x, y: b.position.y })), to, t: 0, dur: FX.resetTweenMs, then }
  }

  private advanceTween(dt: number): void {
    const tw = this.tween
    if (!tw) return
    tw.t = Math.min(tw.dur, tw.t + dt)
    const k = tw.t / tw.dur
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const bodies = [...this.world.caps, this.world.ball]
    bodies.forEach((b, i) => {
      const a = tw.from[i]
      const z = tw.to[i]
      this.world.place(b, { x: a.x + (z.x - a.x) * e, y: a.y + (z.y - a.y) * e })
    })
    if (tw.t >= tw.dur) {
      this.tween = null
      tw.then()
    }
  }

  /** Test/dev helper: skip any running placement tween. */
  completeTween(): void {
    if (this.tween) { this.tween.t = this.tween.dur; this.advanceTween(0) }
  }
}
