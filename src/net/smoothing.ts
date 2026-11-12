/**
 * Render-only reconciliation for authoritative online snapshots.
 *
 * The server still owns every position, velocity, turn and goal. This module only decides
 * where to *draw* a body while a correction settles: the authoritative state is applied
 * immediately in the physics world, and the small visual difference is interpolated away
 * over a bounded time. Large jumps (goals, resets, teleports) snap instead of smearing.
 */

export interface Pose {
  x: number
  y: number
  angle: number
}

export interface InterpolatorOptions {
  /** Corrections larger than this are treated as teleports and snap immediately. */
  snapPx: number
  /** Hard ceiling for the visual offset; reconciliation can never lag further behind than this. */
  maxResidualPx: number
  /** Exponential settle time. 90 ms is roughly three frames at 60 fps. */
  tauMs: number
  /** Below this the offset is considered settled and dropped. */
  restPx: number
}

export interface InterpolatorStats {
  corrections: number
  snapped: number
  maxResidualPx: number
}

const TAU = Math.PI * 2
const finitePose = (p: Pose): boolean =>
  Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle)

export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  const wrapped = angle % TAU
  if (wrapped > Math.PI) return wrapped - TAU
  if (wrapped < -Math.PI) return wrapped + TAU
  return wrapped
}

/** Shortest-arc interpolation between two display poses. `t` is clamped to 0..1. */
export function interpolatePose(from: Pose, to: Pose, t: number): Pose {
  const a = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  return {
    x: from.x + (to.x - from.x) * a,
    y: from.y + (to.y - from.y) * a,
    angle: from.angle + wrapAngle(to.angle - from.angle) * a,
  }
}

const DEFAULTS: InterpolatorOptions = { snapPx: 320, maxResidualPx: 240, tauMs: 90, restPx: 0.35 }

export class RenderInterpolator {
  private residuals: Array<{ x: number; y: number; a: number } | undefined> = []
  readonly stats: InterpolatorStats = { corrections: 0, snapped: 0, maxResidualPx: 0 }
  private readonly options: InterpolatorOptions

  constructor(options: Partial<InterpolatorOptions> = {}) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Drop every pending visual offset (new match, phase change, reconnect). */
  reset(): void { this.residuals = [] }

  /**
   * Reconcile one body. `displayed` is what the player was just looking at and
   * `authoritative` is the new server pose. Returns the visual distance now owed.
   */
  correct(id: number, displayed: Pose, authoritative: Pose): number {
    if (!Number.isInteger(id) || id < 0 || id > 31) return 0
    if (!finitePose(displayed) || !finitePose(authoritative)) return 0
    let dx = displayed.x - authoritative.x
    let dy = displayed.y - authoritative.y
    let distance = Math.hypot(dx, dy)
    if (!Number.isFinite(distance)) return 0

    if (distance > this.options.snapPx) {
      this.residuals[id] = { x: 0, y: 0, a: 0 }
      this.stats.snapped++
      return 0
    }
    if (distance < this.options.restPx) {
      this.residuals[id] = { x: 0, y: 0, a: 0 }
      return 0
    }

    if (distance > this.options.maxResidualPx) {
      const scale = this.options.maxResidualPx / distance
      dx *= scale
      dy *= scale
      distance = this.options.maxResidualPx
    }
    this.residuals[id] = {
      x: dx,
      y: dy,
      a: wrapAngle(displayed.angle - authoritative.angle),
    }
    this.stats.corrections++
    if (distance > this.stats.maxResidualPx) this.stats.maxResidualPx = distance
    return distance
  }

  /** Settle every offset toward zero. Call once per rendered frame. */
  advance(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return
    const k = Math.exp(-dtMs / this.options.tauMs)
    for (let i = 0; i < this.residuals.length; i++) {
      const r = this.residuals[i]
      if (!r) continue
      r.x *= k
      r.y *= k
      r.a *= k
      if (Math.hypot(r.x, r.y) < this.options.restPx) this.residuals[i] = undefined
    }
  }

  /** Authoritative pose plus the still-settling visual offset. */
  apply(id: number, authoritative: Pose): Pose {
    const r = this.residuals[id]
    if (!r || (r.x === 0 && r.y === 0 && r.a === 0)) return authoritative
    return { x: authoritative.x + r.x, y: authoritative.y + r.y, angle: authoritative.angle + r.a }
  }

  residualPx(id: number): number {
    const r = this.residuals[id]
    return r ? Math.hypot(r.x, r.y) : 0
  }
}
