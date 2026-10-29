import Matter from 'matter-js'
import { BALL, CAP_TYPES, PHYSICS, PITCH, SURFACES } from '../config/tuning'
import type { CapType, CapTypeId, Surface, SurfaceId } from '../config/tuning'

const { Engine, Bodies, Body, Composite, Events } = Matter

export type TeamIndex = 0 | 1
export type BoardKind = 'side' | 'byline' | 'net' | 'post'

export interface CapInfo {
  /** Index into PhysicsWorld.caps (0-4 team 0, 5-9 team 1). */
  id: number
  team: TeamIndex
  slot: number
  type: CapType
}

export type BodyTag =
  | { kind: 'cap'; cap: CapInfo }
  | { kind: 'ball' }
  | { kind: 'static'; board: BoardKind; /** goal end this belongs to: 0 = left, 1 = right, -1 = none */ end: -1 | 0 | 1 }

export interface Contact {
  a: BodyTag
  b: BodyTag
  /** Closing speed along the contact normal (wu / base tick). Drives sound, shake and dust. */
  impact: number
  x: number
  y: number
}

export interface BodySnapshot { x: number; y: number; angle: number; vx: number; vy: number; angularVelocity: number; active: boolean }
export interface PhysicsSnapshot { caps: BodySnapshot[]; ball: BodySnapshot }

export interface Vec { x: number; y: number }

const TAG = Symbol('capball-tag')
type TaggedBody = Matter.Body & { [TAG]: BodyTag; grip: number }

export function tagOf(body: Matter.Body): BodyTag {
  return (body as TaggedBody)[TAG]
}

/**
 * Owns the Matter engine. Pure simulation: no DOM, no rendering, runnable in tests.
 * Friction model: Matter's own friction is disabled (frictionAir/friction/frictionStatic = 0
 * on every body) and a single Coulomb sliding-friction pass per step does all the slowing.
 */
export class PhysicsWorld {
  readonly engine: Matter.Engine
  readonly caps: TaggedBody[] = []
  readonly ball: TaggedBody
  readonly dynamic: TaggedBody[] = []
  readonly stepMs = 1000 / PHYSICS.stepHz
  surface: Surface
  /** Extra friction multiplier, ramps only if a play exceeds PHYSICS.maxPlayMs. */
  brake = 1
  private contactListeners = new Set<(c: Contact) => void>()
  private readonly onCollisionStart = (e: Matter.IEventCollision<Matter.Engine>) => this.handleCollisions(e)

  constructor(lineups: [CapTypeId[], CapTypeId[]], surfaceId: SurfaceId = 'park') {
    this.surface = SURFACES[surfaceId]
    this.engine = Engine.create({
      gravity: { x: 0, y: 0, scale: 0 },
      positionIterations: PHYSICS.positionIterations,
      velocityIterations: PHYSICS.velocityIterations,
      enableSleeping: false,
    })
    Composite.add(this.engine.world, this.buildArena())

    lineups.forEach((lineup, team) => {
      lineup.forEach((typeId, slot) => {
        const type = CAP_TYPES[typeId]
        const body = Bodies.circle(0, 0, type.radius, {
          density: type.density,
          restitution: type.restitution,
          friction: PHYSICS.contactFriction,
          frictionAir: 0,
          frictionStatic: 0,
          slop: 0.02,
        }) as TaggedBody
        const info: CapInfo = { id: this.caps.length, team: team as TeamIndex, slot, type }
        body[TAG] = { kind: 'cap', cap: info }
        body.grip = type.grip
        // Spread out before the warm-up tick so no overlap impulses are cached.
        Body.setPosition(body, { x: 120 + slot * 70, y: 120 + team * 300 })
        this.caps.push(body)
      })
    })
    this.ball = Bodies.circle(PITCH.width / 2, PITCH.height / 2, BALL.radius, {
      density: BALL.density,
      restitution: BALL.restitution,
      friction: PHYSICS.contactFriction,
      frictionAir: 0,
      frictionStatic: 0,
      slop: 0.02,
    }) as TaggedBody
    this.ball[TAG] = { kind: 'ball' }
    this.ball.grip = BALL.friction
    this.dynamic.push(...this.caps, this.ball)
    Composite.add(this.engine.world, this.dynamic)
    this.applySurface()
    Events.on(this.engine, 'collisionStart', this.onCollisionStart)
    // Warm-up tick so every body's deltaTime matches the fixed step before the first flick.
    Engine.update(this.engine, this.stepMs)
  }

  capInfo(id: number): CapInfo {
    return (tagOf(this.caps[id]) as { kind: 'cap'; cap: CapInfo }).cap
  }

  setSurface(id: SurfaceId): void {
    this.surface = SURFACES[id]
    this.applySurface()
  }

  private applySurface(): void {
    for (const b of this.engine.world.bodies) {
      const t = tagOf(b)
      if (t?.kind === 'static' && (t.board === 'side' || t.board === 'byline')) b.restitution = this.surface.boardBounce
    }
  }

  onContact(fn: (c: Contact) => void): () => void {
    this.contactListeners.add(fn)
    return () => this.contactListeners.delete(fn)
  }

  /** One fixed step: slope → curl → single friction pass → Matter integration/collisions → safety clamp. */
  step(): void {
    const dt = this.stepMs / 1000
    const slope = this.surface.slope
    for (const b of this.dynamic) {
      let vx = b.velocity.x + slope.x * dt
      let vy = b.velocity.y + slope.y * dt
      // Curl: spin turns the heading (pure rotation of the velocity — speed is unchanged).
      const w = b.angularVelocity
      if (w !== 0 && (vx !== 0 || vy !== 0)) {
        const th = PHYSICS.curl * w * dt
        const c = Math.cos(th)
        const sn = Math.sin(th)
        const rx = vx * c - vy * sn
        vy = vx * sn + vy * c
        vx = rx
      }
      const s = Math.hypot(vx, vy)
      const f = b.grip * this.surface.frictionScale * this.brake * dt
      if (s <= f) { vx = 0; vy = 0 } else { const k = (s - f) / s; vx *= k; vy *= k }
      Body.setVelocity(b, { x: vx, y: vy })
      const fw = PHYSICS.spinFriction * dt
      Body.setAngularVelocity(b, Math.abs(w) <= fw ? 0 : w - Math.sign(w) * fw)
    }
    Engine.update(this.engine, this.stepMs)
    for (const b of this.dynamic) {
      const s = b.speed
      if (s > PHYSICS.maxSpeed) Body.setVelocity(b, { x: (b.velocity.x / s) * PHYSICS.maxSpeed, y: (b.velocity.y / s) * PHYSICS.maxSpeed })
    }
  }

  /**
   * Apply a flick impulse to a cap. Speed comes from impulse / mass — no fixed distances.
   * `spin` (rad per base tick, + = clockwise on screen) comes from an off-centre grab.
   */
  flick(capId: number, dir: Vec, impulse: number, spin = 0): void {
    const body = this.caps[capId]
    const info = this.capInfo(capId)
    const speed = (impulse * info.type.power) / body.mass
    const len = Math.hypot(dir.x, dir.y) || 1
    Body.setVelocity(body, { x: (dir.x / len) * speed, y: (dir.y / len) * speed })
    Body.setAngularVelocity(body, spin)
  }

  /** Re-read cap/ball material values from the tuning config (live tuning overlay). */
  retune(): void {
    for (const b of this.caps) {
      const t = this.capInfo(this.caps.indexOf(b)).type
      const live = CAP_TYPES[t.id]
      b.grip = live.grip
      b.restitution = live.restitution
      if (Math.abs(b.density - live.density) > 1e-9) Body.setDensity(b, live.density)
    }
    this.ball.grip = BALL.friction
    this.ball.restitution = BALL.restitution
    this.applySurface()
  }

  isAtRest(): boolean {
    return this.dynamic.every(b => b.speed < PHYSICS.restSpeed && Math.abs(b.angularVelocity) < PHYSICS.restAngularSpeed)
  }

  maxSpeed(): number {
    let m = 0
    for (const b of this.dynamic) m = Math.max(m, b.speed)
    return m
  }

  /** Place a body (between plays only — kickoff/set-piece setup). Velocity is zeroed. */
  place(body: Matter.Body, p: Vec, angle?: number): void {
    Body.setPosition(body, p)
    if (angle !== undefined) Body.setAngle(body, angle)
    Body.setVelocity(body, { x: 0, y: 0 })
    Body.setAngularVelocity(body, 0)
    // Drop Matter's warm-started correction impulses so a placed body never gets shoved later.
    const internal = body as Matter.Body & { positionImpulse: Vec; constraintImpulse: Vec & { angle: number } }
    internal.positionImpulse.x = 0
    internal.positionImpulse.y = 0
    internal.constraintImpulse.x = 0
    internal.constraintImpulse.y = 0
    internal.constraintImpulse.angle = 0
  }

  /** Remove/restore a cap from the simulation (penalty shootout benches the other caps). */
  setActive(body: Matter.Body, active: boolean): void {
    const inWorld = this.engine.world.bodies.includes(body)
    if (active && !inWorld) Composite.add(this.engine.world, body)
    if (!active && inWorld) Composite.remove(this.engine.world, body)
    const i = this.dynamic.indexOf(body as TaggedBody)
    if (active && i < 0) this.dynamic.push(body as TaggedBody)
    if (!active && i >= 0) this.dynamic.splice(i, 1)
  }

  isActive(body: Matter.Body): boolean {
    return this.dynamic.includes(body as TaggedBody)
  }

  /** Flat [x, y, angle] for every cap then the ball (replay recording). */
  writeSnapshot(out: Float32Array, offset: number): void {
    let o = offset
    for (const b of this.caps) { out[o++] = b.position.x; out[o++] = b.position.y; out[o++] = b.angle }
    out[o++] = this.ball.position.x; out[o++] = this.ball.position.y; out[o++] = this.ball.angle
  }

  /** Serializable complete state for the server referee and online client correction. */
  snapshot(): PhysicsSnapshot {
    const read = (body: Matter.Body, active: boolean): BodySnapshot => ({
      x: body.position.x, y: body.position.y, angle: body.angle,
      vx: body.velocity.x, vy: body.velocity.y, angularVelocity: body.angularVelocity, active,
    })
    return { caps: this.caps.map(body => read(body, this.isActive(body))), ball: read(this.ball, true) }
  }

  /** Apply an authoritative snapshot without replacing bodies or event handlers. */
  restore(snapshot: PhysicsSnapshot): void {
    if (snapshot.caps.length !== this.caps.length) throw new Error('CAPBALL snapshot cap count mismatch')
    const put = (body: Matter.Body, state: BodySnapshot) => {
      Body.setPosition(body, { x: state.x, y: state.y })
      Body.setAngle(body, state.angle)
      Body.setVelocity(body, { x: state.vx, y: state.vy })
      Body.setAngularVelocity(body, state.angularVelocity)
      const internal = body as Matter.Body & { positionImpulse: Vec; constraintImpulse: Vec & { angle: number } }
      internal.positionImpulse.x = 0; internal.positionImpulse.y = 0
      internal.constraintImpulse.x = 0; internal.constraintImpulse.y = 0; internal.constraintImpulse.angle = 0
    }
    for (let i = 0; i < this.caps.length; i++) {
      const body = this.caps[i]
      const state = snapshot.caps[i]
      this.setActive(body, state.active)
      if (state.active) put(body, state)
    }
    put(this.ball, snapshot.ball)
  }

  get bodyCount(): number { return this.caps.length + 1 }

  destroy(): void {
    Events.off(this.engine, 'collisionStart', this.onCollisionStart)
    this.contactListeners.clear()
    Composite.clear(this.engine.world, false, true)
    Engine.clear(this.engine)
  }

  private handleCollisions(e: Matter.IEventCollision<Matter.Engine>): void {
    for (const pair of e.pairs) {
      const a = tagOf(pair.bodyA.parent)
      const b = tagOf(pair.bodyB.parent)
      if (!a || !b) continue
      // A spinning cap hands part of its spin to the ball, so curled shots bend the ball too.
      const capBody = a.kind === 'cap' && b.kind === 'ball' ? pair.bodyA.parent : b.kind === 'cap' && a.kind === 'ball' ? pair.bodyB.parent : null
      if (capBody && capBody.angularVelocity !== 0) {
        Body.setAngularVelocity(this.ball, this.ball.angularVelocity + capBody.angularVelocity * PHYSICS.spinTransfer)
      }
      if (!this.contactListeners.size) continue
      const va = pair.bodyA.parent.velocity
      const vb = pair.bodyB.parent.velocity
      const n = pair.collision.normal
      const impact = Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y)
      const sup = pair.collision.supports[0] ?? pair.bodyA.position
      const c: Contact = { a, b, impact, x: sup.x, y: sup.y }
      for (const fn of this.contactListeners) fn(c)
    }
  }

  private buildArena(): Matter.Body[] {
    const { width: W, height: H, boardThickness: T, goalWidth: GW, goalDepth: GD, postRadius: PR } = PITCH
    const top = (H - GW) / 2
    const bottom = (H + GW) / 2
    const opts = (restitution: number): Matter.IChamferableBodyDefinition => ({
      isStatic: true, restitution, friction: 0, frictionStatic: 0, slop: 0.02,
    })
    const bodies: Matter.Body[] = []
    const add = (b: Matter.Body, board: BoardKind, end: -1 | 0 | 1) => {
      (b as TaggedBody)[TAG] = { kind: 'static', board, end }
      bodies.push(b)
    }
    // Side boards (long touchlines), extended past the goal depth.
    const span = W + 2 * (GD + T)
    add(Bodies.rectangle(W / 2, -T / 2, span, T, opts(0.6)), 'side', -1)
    add(Bodies.rectangle(W / 2, H + T / 2, span, T, opts(0.6)), 'side', -1)
    for (const end of [0, 1] as const) {
      const lineX = end === 0 ? 0 : W
      const out = end === 0 ? -1 : 1
      // Byline boards either side of the goal mouth.
      const segH = top
      add(Bodies.rectangle(lineX + (out * T) / 2, segH / 2, T, segH, opts(0.6)), 'byline', end)
      add(Bodies.rectangle(lineX + (out * T) / 2, H - segH / 2, T, segH, opts(0.6)), 'byline', end)
      // Goal: back net and two side nets (thick, soft).
      const backX = lineX + out * (GD + T / 2)
      add(Bodies.rectangle(backX, H / 2, T, GW + 2 * T, opts(0.12)), 'net', end)
      // Goal side nets sit inside the byline boards' footprint; they share the same face lines.
      add(Bodies.rectangle(lineX + (out * GD) / 2, top - T / 2, GD, T, opts(0.12)), 'net', end)
      add(Bodies.rectangle(lineX + (out * GD) / 2, bottom + T / 2, GD, T, opts(0.12)), 'net', end)
      // Solid round posts at the mouth.
      add(Bodies.circle(lineX, top, PR, opts(0.7)), 'post', end)
      add(Bodies.circle(lineX, bottom, PR, opts(0.7)), 'post', end)
    }
    return bodies
  }
}
