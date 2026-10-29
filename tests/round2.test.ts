import { afterEach, describe, expect, it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import type { Ruleset } from '../src/config/rulesets'
import { BALL, CAP_TYPES, DEADBALL, INPUT, PITCH, PHYSICS } from '../src/config/tuning'
import { DeadBallWatch, dropSpot, edgesTouching, isPinned } from '../src/game/deadball'
import { Match } from '../src/game/match'
import { setPieceTargets } from '../src/game/setpieces'
import { computeSpin } from '../src/input/flick'
import { TuningSession, buildCatalog } from '../src/debug/tunables'

const FRAME = 1000 / 60
const run = (m: Match, ms: number, until?: () => boolean) => {
  for (let t = 0; t < ms; t += FRAME) { m.update(FRAME); if (until?.()) return t }
  return ms
}
const rules = (over: Partial<Ruleset> = {}): Ruleset => ({ ...RULESETS.street, ...over })

/** Lone striker (slot 4, team 0) flicked right from (80, 310); everything else parked out of the way. */
function soloFlick(spin: number, power = 0.7, ruleset = rules()) {
  const m = new Match({ ruleset, surface: 'park' })
  m.world.caps.forEach((b, i) => { if (i !== 4) m.world.place(b, { x: 960, y: 30 + i * 55 }) })
  m.world.place(m.world.ball, { x: 975, y: 590 })
  m.world.place(m.world.caps[4], { x: 80, y: 310 })
  expect(m.tryFlick(4, { x: 1, y: 0 }, power, spin)).toBe(true)
  const launch = m.world.caps[4].speed
  let path = 0
  let prev = { ...m.world.caps[4].position }
  run(m, 15000, () => {
    const p = m.world.caps[4].position
    path += Math.hypot(p.x - prev.x, p.y - prev.y)
    prev = { x: p.x, y: p.y }
    return m.phase !== 'moving'
  })
  const end = { ...m.world.caps[4].position }
  m.destroy()
  return { end, launch, path }
}

describe('spin flicks', () => {
  it('grab right of the line of travel spins anticlockwise (curls left); left of it, clockwise', () => {
    const dir = { x: 1, y: 0 } // travelling right; screen y is down, so "right of travel" is +y
    expect(computeSpin(dir, { x: 0, y: 20 }, 22, 30)).toBeLessThan(0)
    expect(computeSpin(dir, { x: 0, y: -20 }, 22, 30)).toBeGreaterThan(0)
  })
  it('a central grab is dead straight and a far edge grab is capped at full spin', () => {
    const dir = { x: 0, y: -1 }
    expect(computeSpin(dir, { x: 22 * INPUT.spinDeadzone * 0.9, y: 0 }, 22, 30)).toBe(0)
    expect(Math.abs(computeSpin(dir, { x: 80, y: 0 }, 22, 30))).toBe(1)
  })
  it('spin bends the path to the side it spins toward; no spin runs straight', () => {
    const straight = soloFlick(0)
    const right = soloFlick(1)
    const left = soloFlick(-1)
    expect(Math.abs(straight.end.y - 310)).toBeLessThan(1)
    expect(right.end.y - 310).toBeGreaterThan(40)
    expect(left.end.y - 310).toBeLessThan(-40)
    // symmetric
    expect(Math.abs((right.end.y - 310) + (left.end.y - 310))).toBeLessThan(3)
  })
  it('curl only turns the velocity: same launch speed, similar slide length', () => {
    const a = soloFlick(0)
    const b = soloFlick(1)
    expect(b.launch).toBeCloseTo(a.launch, 5)
    expect(Math.abs(b.path - a.path) / a.path).toBeLessThan(0.08)
  })
  it('rulesets with spin off ignore it', () => {
    const r = soloFlick(1, 0.7, rules({ spin: false }))
    expect(Math.abs(r.end.y - 310)).toBeLessThan(1)
  })
  it('a spun cap still settles cleanly and hands the turn over', () => {
    const m = new Match({ ruleset: rules(), surface: 'court' })
    m.tryFlick(4, { x: 1, y: 0.1 }, 1, 1)
    run(m, 20000, () => m.phase === 'aim')
    expect(m.phase).toBe('aim')
    expect(m.team).toBe(1)
    expect(m.world.maxSpeed()).toBe(0)
    m.destroy()
  })
})

describe('stuck ball', () => {
  const r = BALL.radius
  it('a ball wedged in a corner is pinned; a free ball along a board is not', () => {
    expect(edgesTouching({ x: r + 1, y: r + 1 })).toBe(2)
    expect(isPinned({ x: r + 1, y: r + 1 }, [])).toBe(true)
    expect(isPinned({ x: 500, y: r + 1 }, [])).toBe(false)
    expect(isPinned({ x: 500, y: 300 }, [{ x: 500, y: 300 + r + 22, r: 22 }])).toBe(false)
  })
  it('a cap squeezing a ball against the boards pins it', () => {
    expect(isPinned({ x: 500, y: r + 1 }, [{ x: 500, y: r + 1 + r + 22 + 1, r: 22 }])).toBe(true)
  })
  it('drops after N unmoved pinned plays; any movement resets the count', () => {
    const w = new DeadBallWatch(2)
    const corner = { x: r + 1, y: r + 1 }
    expect(w.afterPlay(corner, corner, [])).toBe(false)
    expect(w.afterPlay(corner, { x: corner.x + DEADBALL.moveEps + 1, y: corner.y }, [])).toBe(false)
    expect(w.count).toBe(0)
    expect(w.afterPlay(corner, corner, [])).toBe(false)
    expect(w.afterPlay(corner, corner, [])).toBe(true)
    expect(new DeadBallWatch(0).afterPlay(corner, corner, [])).toBe(false)
  })
  it('the drop spot is off the boards, toward the centre', () => {
    const s = dropSpot({ x: r + 1, y: PITCH.height - r - 1 })
    expect(isPinned(s, [])).toBe(false)
    expect(s.x).toBeGreaterThan(r + 30)
    expect(s.y).toBeLessThan(PITCH.height - r - 30)
  })
  it('dropped-ball placement clears every cap out of the drop radius', () => {
    const at = { x: 120, y: 120 }
    const types = ['keeper', 'defender', 'defender', 'winger', 'striker'] as const
    const caps = Array.from({ length: 10 }, (_, id) => ({ id, team: (id < 5 ? 0 : 1) as 0 | 1, slot: id % 5, type: types[id % 5], x: at.x + (id % 3) * 10, y: at.y + (id % 2) * 10, active: true }))
    const t = setPieceTargets({ kind: 'dropball', next: 0, at }, caps, at, rules())!
    expect(t.ball).toEqual(at)
    t.caps.forEach((p, id) => {
      const rr = CAP_TYPES[caps[id].type].radius
      expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeGreaterThanOrEqual(DEADBALL.clearRadius + rr - 0.01)
    })
    for (let i = 0; i < t.caps.length; i++) for (let j = i + 1; j < t.caps.length; j++) {
      const d = Math.hypot(t.caps[i].x - t.caps[j].x, t.caps[i].y - t.caps[j].y)
      expect(d).toBeGreaterThanOrEqual(CAP_TYPES[caps[i].type].radius + CAP_TYPES[caps[j].type].radius - 0.01)
    }
  })
  it('in a real match a corner-wedged ball is dropped back in after two dead plays', () => {
    const m = new Match({ ruleset: rules({ corners: false }), surface: 'park' })
    const whistles: string[] = []
    m.events.on('whistle', w => whistles.push(w.kind))
    m.world.place(m.world.ball, { x: r + 0.5, y: r + 0.5 })
    for (let k = 0; k < 2; k++) {
      // each team taps its keeper gently, nowhere near the ball
      const keeper = m.team === 0 ? 0 : 5
      expect(m.tryFlick(keeper, { x: 0, y: 1 }, 0.05)).toBe(true)
      run(m, 10000, () => m.phase === 'aim')
    }
    expect(whistles).toContain('dropball')
    expect(m.reason).toBe('dropball')
    expect(isPinned(m.world.ball.position, [])).toBe(false)
    m.destroy()
  })
})

describe('tuning catalog', () => {
  const session = new TuningSession()
  const list = buildCatalog('park')
  session.track(list)
  afterEach(() => session.reset(list))
  it('edits the live config objects, lists changes and resets', () => {
    const curl = list.find(t => t.id === 'PHYSICS.curl')!
    const before = PHYSICS.curl
    curl.set(before + 1)
    expect(PHYSICS.curl).toBe(before + 1)
    expect(session.changes(list)).toEqual([{ id: 'PHYSICS.curl', from: before, to: before + 1 }])
    expect(session.exportText(list)).toContain('PHYSICS.curl')
    session.reset(list)
    expect(PHYSICS.curl).toBe(before)
    expect(session.exportText(list)).toContain('No changes')
  })
  it('material changes reach existing bodies through retune()', () => {
    const m = new Match({ ruleset: rules(), surface: 'park' })
    const wingerId = m.world.caps.findIndex((_, i) => m.world.capInfo(i).type.id === 'winger')
    const g = list.find(t => t.id === 'CAP_TYPES.winger.grip')!
    g.set(33)
    m.world.retune()
    expect((m.world.caps[wingerId] as unknown as { grip: number }).grip).toBe(33)
    m.destroy()
  })
  it('every entry stays inside its slider range at the file defaults', () => {
    for (const t of list) {
      expect(t.get()).toBeGreaterThanOrEqual(t.min)
      expect(t.get()).toBeLessThanOrEqual(t.max)
    }
  })
})

describe('corners and goal kicks', () => {
  const types = ['keeper', 'defender', 'defender', 'winger', 'striker'] as const
  const caps = Array.from({ length: 10 }, (_, id) => ({ id, team: (id < 5 ? 0 : 1) as 0 | 1, slot: id % 5, type: types[id % 5], x: 300 + id * 40, y: 200 + (id % 3) * 90, active: true }))
  const R = (i: number) => CAP_TYPES[caps[i].type].radius
  for (const [end, ay] of [[1, 5], [1, PITCH.height - 5], [0, 5], [0, PITCH.height - 5]] as const) {
    it(`corner at end ${end} (${ay < 300 ? 'top' : 'bottom'}): taker behind the ball, box crowded, defenders back`, () => {
      const kicker = end === 1 ? 0 : 1
      const t = setPieceTargets({ kind: 'corner', next: kicker, end, at: { x: end === 1 ? PITCH.width + 5 : -5, y: ay } }, caps, { x: 0, y: 0 }, rules())!
      const lineX = end === 1 ? PITCH.width : 0
      const depth = (p: { x: number }) => Math.abs(p.x - lineX)
      // ball near the corner, inside the pitch
      expect(depth(t.ball)).toBeLessThan(90)
      expect(Math.min(t.ball.y, PITCH.height - t.ball.y)).toBeLessThan(90)
      // taker (winger) touching distance behind the ball, pointing at the penalty spot
      const taker = caps.find(c => c.team === kicker && c.slot === 3)!
      const tp = t.caps[taker.id]
      expect(Math.hypot(tp.x - t.ball.x, tp.y - t.ball.y)).toBeCloseTo(BALL.radius + R(taker.id) + 3, 0)
      const spot = { x: lineX + (end === 1 ? -1 : 1) * PITCH.penaltySpot, y: PITCH.height / 2 }
      const a1 = Math.atan2(t.ball.y - tp.y, t.ball.x - tp.x)
      const a2 = Math.atan2(spot.y - t.ball.y, spot.x - t.ball.x)
      expect(Math.abs(a1 - a2)).toBeLessThan(0.05)
      // at least 3 attackers (incl. taker's targets) within 200 of the goal line
      const attackersNear = caps.filter(c => c.team === kicker && c.slot !== 0 && c !== taker && depth(t.caps[c.id]) < 200)
      expect(attackersNear.length).toBeGreaterThanOrEqual(3)
      // defending keeper on its line; every defender at wall distance
      const keeper = caps.find(c => c.team !== kicker && c.slot === 0)!
      expect(depth(t.caps[keeper.id])).toBeLessThan(R(keeper.id) + 6)
      for (const c of caps.filter(c => c.team !== kicker)) {
        expect(Math.hypot(t.caps[c.id].x - t.ball.x, t.caps[c.id].y - t.ball.y)).toBeGreaterThanOrEqual(rules().wallDistance + R(c.id) - 0.01)
      }
      // nothing overlaps, everything on the pitch
      for (let i = 0; i < 10; i++) {
        const p = t.caps[i]
        expect(p.x).toBeGreaterThanOrEqual(R(i)); expect(p.x).toBeLessThanOrEqual(PITCH.width - R(i))
        expect(p.y).toBeGreaterThanOrEqual(R(i)); expect(p.y).toBeLessThanOrEqual(PITCH.height - R(i))
        expect(Math.hypot(p.x - t.ball.x, p.y - t.ball.y)).toBeGreaterThanOrEqual(R(i) + BALL.radius - 0.01)
        for (let j = i + 1; j < 10; j++) expect(Math.hypot(p.x - t.caps[j].x, p.y - t.caps[j].y)).toBeGreaterThanOrEqual(R(i) + R(j) - 0.01)
      }
    })
  }
})

describe('ball out needs pace', () => {
  it('a soft roll into the end board plays on; a real hit is out', async () => {
    const { PlayTracker, newPossession } = await import('../src/game/play')
    const flicker = { id: 4, team: 0 as const, slot: 4, type: CAP_TYPES.striker }
    const mk = () => new PlayTracker(flicker, rules(), newPossession(), { touchingBallAtFlick: false, offsideAtFlick: new Set() })
    const ballTag = { kind: 'ball' as const }
    const byline = { kind: 'static' as const, board: 'byline' as const, end: 1 as const }
    const soft = mk()
    soft.onContact({ a: { kind: 'cap', cap: flicker }, b: ballTag, x: 900, y: 50, impact: 4 })
    soft.onContact({ a: ballTag, b: byline, x: 1000, y: 50, impact: rules().outMinImpact - 0.5 })
    expect(soft.resolve().kind).toBe('normal')
    const hard = mk()
    hard.onContact({ a: { kind: 'cap', cap: flicker }, b: ballTag, x: 900, y: 50, impact: 4 })
    hard.onContact({ a: ballTag, b: byline, x: 1000, y: 50, impact: rules().outMinImpact + 0.5 })
    expect(hard.resolve().kind).toBe('goalkick')
  })
})
