import { BALL, CAP_TYPES, INPUT, PHYSICS, SURFACES } from '../config/tuning'
import type { CapTypeId, SurfaceId } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'

/**
 * Live tuning catalog for the in-game overlay. Every entry reads and writes the SAME objects
 * exported by src/config/tuning.ts, so gameplay picks changes up immediately. Nothing is persisted:
 * a reload restores the file's values. "Export" lists the changes to paste back into tuning.ts.
 */
export interface Tunable {
  id: string
  group: string
  label: string
  min: number
  max: number
  step: number
  get(): number
  set(v: number): void
  /** Needs PhysicsWorld.retune() after a change (material values copied onto bodies). */
  retune?: boolean
}

type Obj = Record<string, unknown>
const num = (o: object, k: string) => (o as Obj)[k] as number
const put = (o: object, k: string, v: number) => { (o as Obj)[k] = v }

function field(id: string, group: string, label: string, obj: object, key: string, min: number, max: number, step: number, retune = false): Tunable {
  return { id, group, label, min, max, step, retune, get: () => num(obj, key), set: v => put(obj, key, v) }
}

const CAP_ORDER: CapTypeId[] = ['standard', 'keeper', 'defender', 'winger', 'striker']

/** Catalog for the given surface (surface entries edit that surface only) and, optionally, the live match ruleset. */
export function buildCatalog(surface: SurfaceId, rules?: Ruleset): Tunable[] {
  const s = SURFACES[surface]
  const list: Tunable[] = [
    field('INPUT.maxImpulse', 'Flick', 'Flick strength (impulse)', INPUT, 'maxImpulse', 20, 120, 1),
    field('INPUT.powerCurve', 'Flick', 'Power curve (>1 = finer soft touch)', INPUT, 'powerCurve', 0.6, 2.5, 0.05),
    field('INPUT.maxDrag', 'Flick', 'Drag for full power (wu)', INPUT, 'maxDrag', 80, 320, 5),
    field('INPUT.minDrag', 'Flick', 'Minimum drag (wu)', INPUT, 'minDrag', 4, 60, 1),
    field('INPUT.maxSpin', 'Spin', 'Max spin (rad/tick)', INPUT, 'maxSpin', 0, 0.8, 0.01),
    field('INPUT.spinDeadzone', 'Spin', 'Straight zone (× cap radius)', INPUT, 'spinDeadzone', 0, 0.95, 0.05),
    field('PHYSICS.curl', 'Spin', 'Curl strength', PHYSICS, 'curl', 0, 8, 0.1),
    field('PHYSICS.spinFriction', 'Spin', 'Spin decay', PHYSICS, 'spinFriction', 0.05, 2, 0.01),
    field('PHYSICS.spinTransfer', 'Spin', 'Spin passed to ball', PHYSICS, 'spinTransfer', 0, 1.5, 0.05),
    field('PHYSICS.settleHoldMs', 'Physics', 'Settle hold (ms)', PHYSICS, 'settleHoldMs', 0, 600, 10),
    field(`SURFACES.${surface}.frictionScale`, `Surface: ${s.name}`, 'Friction scale', s, 'frictionScale', 0.2, 2.5, 0.05),
    field(`SURFACES.${surface}.boardBounce`, `Surface: ${s.name}`, 'Board bounce', s, 'boardBounce', 0, 1, 0.01, true),
    field(`SURFACES.${surface}.slope.x`, `Surface: ${s.name}`, 'Slope →', s.slope, 'x', -8, 8, 0.1),
    field(`SURFACES.${surface}.slope.y`, `Surface: ${s.name}`, 'Slope ↓', s.slope, 'y', -8, 8, 0.1),
    field('BALL.friction', 'Ball', 'Rolling friction', BALL, 'friction', 1, 20, 0.1, true),
    field('BALL.restitution', 'Ball', 'Bounce', BALL, 'restitution', 0, 1, 0.01, true),
    field('BALL.density', 'Ball', 'Density', BALL, 'density', 0.0003, 0.004, 0.0001, true),
  ]
  if (rules) {
    list.push(
      field('RULES.outMinImpact', 'Rules (this match)', 'Ball out: min hit on end board', rules, 'outMinImpact', 0, 8, 0.1),
      field('RULES.wallDistance', 'Rules (this match)', 'Wall distance (wu)', rules, 'wallDistance', 20, 160, 2),
    )
  }
  for (const id of CAP_ORDER) {
    const t = CAP_TYPES[id]
    const g = `Cap: ${t.label}`
    list.push(
      field(`CAP_TYPES.${id}.grip`, g, 'Grip (sliding friction)', t, 'grip', 2, 60, 0.5, true),
      field(`CAP_TYPES.${id}.restitution`, g, 'Bounce', t, 'restitution', 0, 1, 0.01, true),
      field(`CAP_TYPES.${id}.power`, g, 'Flick power ×', t, 'power', 0.3, 2.5, 0.05),
      field(`CAP_TYPES.${id}.density`, g, 'Density (weight)', t, 'density', 0.0005, 0.006, 0.0001, true),
    )
  }
  return list
}

/** Remembers the file's values the first time a parameter is seen, so changes can be listed and reset. */
export class TuningSession {
  private defaults = new Map<string, number>()

  track(list: Tunable[]): void {
    for (const t of list) if (!this.defaults.has(t.id)) this.defaults.set(t.id, t.get())
  }

  changes(list: Tunable[]): { id: string; from: number; to: number }[] {
    this.track(list)
    return list
      .filter(t => Math.abs(t.get() - this.defaults.get(t.id)!) > 1e-9)
      .map(t => ({ id: t.id, from: this.defaults.get(t.id)!, to: t.get() }))
  }

  reset(list: Tunable[]): void {
    for (const t of list) { const d = this.defaults.get(t.id); if (d !== undefined) t.set(d) }
  }

  /** Paste-ready summary for src/config/tuning.ts. */
  exportText(list: Tunable[]): string {
    const ch = this.changes(list)
    if (!ch.length) return '// No changes from src/config/tuning.ts'
    return ['// CAPBALL tuning changes — edit these in src/config/tuning.ts', ...ch.map(c => `${c.id}: ${fmt(c.from)} → ${fmt(c.to)}`)].join('\n')
  }
}

export function fmt(v: number): string {
  if (Math.abs(v) < 0.01 && v !== 0) return v.toFixed(4)
  return String(Math.round(v * 1000) / 1000)
}
