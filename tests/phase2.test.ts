import { describe, expect, it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import type { Ruleset } from '../src/config/rulesets'
import { CAP_TYPES, PITCH } from '../src/config/tuning'
import type { SurfaceId } from '../src/config/tuning'
import { Match } from '../src/game/match'
import { PlayTracker, inPenaltyBox, newPossession, offsideCaps } from '../src/game/play'
import { setPieceTargets } from '../src/game/setpieces'
import { basePosition } from '../src/game/formation'
import type { BodyTag, CapInfo, Contact } from '../src/physics/world'

const FRAME = 1000 / 60
const run = (m: Match, ms: number, until?: () => boolean) => {
  for (let t = 0; t < ms; t += FRAME) { m.update(FRAME); if (until?.()) return t }
  return ms
}
const cap = (id: number, team: 0 | 1, slot = id % 5): CapInfo => ({ id, team, slot, type: CAP_TYPES.standard })
const T = (c: CapInfo): BodyTag => ({ kind: 'cap', cap: c })
const BALL: BodyTag = { kind: 'ball' }
const SIDE: BodyTag = { kind: 'static', board: 'side', end: -1 }
const BYLINE = (end: 0 | 1): BodyTag => ({ kind: 'static', board: 'byline', end })
const hit = (a: BodyTag, b: BodyTag, x = 500, y = 300, impact = 5): Contact => ({ a, b, x, y, impact })
const rules = (over: Partial<Ruleset> = {}): Ruleset => ({ ...RULESETS.street, ...over })
const tracker = (flicker: CapInfo, r = rules(), pos = newPossession(), offside = new Set<number>()) =>
  new PlayTracker(flicker, r, pos, { touchingBallAtFlick: false, offsideAtFlick: offside })

describe('play tracker — fouls & penalties', () => {
  it('flicked cap hitting an opponent before the ball is a free kick to the victim', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), T(cap(7, 1)), 600, 300))
    expect(t.resolve()).toMatchObject({ kind: 'freekick', next: 1, at: { x: 600, y: 300 } })
  })
  it('touching the ball first is never a foul', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(T(cap(4, 0)), T(cap(7, 1))))
    expect(t.resolve()).toMatchObject({ kind: 'normal', next: 1 })
  })
  it('a foul in your own box is a penalty', () => {
    const t = tracker(cap(9, 1))
    t.onContact(hit(T(cap(9, 1)), T(cap(4, 0)), PITCH.width - 60, 310))
    expect(t.resolve()).toMatchObject({ kind: 'penalty', next: 0, end: 1 })
    expect(inPenaltyBox({ x: 50, y: 310 }, 0)).toBe(true)
    expect(inPenaltyBox({ x: 500, y: 310 }, 0)).toBe(false)
  })
  it('free kicks off in loose arcade', () => {
    const t = tracker(cap(4, 0), RULESETS.arcade)
    t.onContact(hit(T(cap(4, 0)), T(cap(7, 1))))
    expect(t.resolve().kind).toBe('normal')
  })
})

describe('play tracker — corners & goal kicks', () => {
  it('flick rule: your flick into the opponents\' end is a goal kick to them — even off their cap', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(T(cap(5, 1)), BALL)) // deflects off a team-1 cap on the way out
    t.onContact(hit(BALL, BYLINE(1), PITCH.width, 80))
    expect(t.resolve()).toMatchObject({ kind: 'goalkick', next: 1, end: 1 })
  })
  it('flick rule: your flick into your own end is a corner to them — even off their cap', () => {
    const t = tracker(cap(2, 0))
    t.onContact(hit(T(cap(2, 0)), BALL)) // plays the ball...
    t.onContact(hit(T(cap(8, 1)), BALL)) // ...it clips an opponent cap last
    t.onContact(hit(BALL, BYLINE(0), 0, 80)) // into team 0's own end
    expect(t.resolve()).toMatchObject({ kind: 'corner', next: 1, end: 0 })
  })
  it('last-touch rule (Proper Football): defender last touch over the byline → corner to attackers', () => {
    expect(RULESETS.proper.outBy).toBe('lastTouch')
    const pos = newPossession()
    const t = tracker(cap(4, 0), rules({ outBy: 'lastTouch' }), pos)
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(T(cap(5, 1)), BALL)) // team 1 defends end 1
    t.onContact(hit(BALL, BYLINE(1), PITCH.width, 80))
    expect(t.resolve()).toMatchObject({ kind: 'corner', next: 0, end: 1 })
  })
  it('last-touch rule: attacker last touch over the byline → goal kick', () => {
    const t = tracker(cap(4, 0), rules({ outBy: 'lastTouch' }))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, BYLINE(1), PITCH.width, 500))
    expect(t.resolve()).toMatchObject({ kind: 'goalkick', next: 1, end: 1 })
  })
})

describe('play tracker — boards as a teammate', () => {
  it('ball off a board onto your own cap earns a bonus flick', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, SIDE))
    t.onContact(hit(BALL, T(cap(3, 0))))
    expect(t.resolve()).toMatchObject({ kind: 'bonus', next: 0 })
  })
  it('ball off a board onto an opponent earns nothing (and clears the chance)', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, SIDE))
    t.onContact(hit(BALL, T(cap(6, 1))))
    t.onContact(hit(BALL, T(cap(3, 0))))
    expect(t.resolve().kind).toBe('normal')
  })
  it('a corner beats a bonus when the ball went out over the byline', () => {
    const t = tracker(cap(4, 0))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, BYLINE(1), PITCH.width, 60))
    t.onContact(hit(BALL, SIDE))
    t.onContact(hit(BALL, T(cap(3, 0))))
    expect(t.resolve().kind).toBe('goalkick')
  })
})

describe('combos', () => {
  it('chaining passes charges a power shot; opponent touch resets the chain', () => {
    const pos = newPossession()
    const r = rules()
    const n = r.combos.passesForPowerShot
    const t = tracker(cap(4, 0), r, pos)
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, T(cap(3, 0))))
    expect(pos.chain[0]).toBe(1)
    t.onContact(hit(BALL, T(cap(6, 1))))
    expect(pos.chain[0]).toBe(0)
    const ids = [1, 2, 3, 4, 1, 2]
    t.onContact(hit(BALL, T(cap(4, 0))))
    for (let i = 0; i < n; i++) t.onContact(hit(BALL, T(cap(ids[i], 0))))
    expect(pos.powerReady[0]).toBe(true)
    expect(t.take().some(e => e.type === 'powerReady')).toBe(true)
  })
  it('the same cap touching twice is not a pass', () => {
    const pos = newPossession()
    const t = tracker(cap(4, 0), rules(), pos)
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, T(cap(4, 0))))
    expect(pos.chain[0]).toBe(0)
  })
})

describe('offside', () => {
  const caps = [
    { id: 0, team: 0 as const, x: 60, y: 310 }, { id: 4, team: 0 as const, x: 400, y: 310 }, { id: 3, team: 0 as const, x: 880, y: 100 },
    { id: 5, team: 1 as const, x: 950, y: 310 }, { id: 6, team: 1 as const, x: 800, y: 200 }, { id: 7, team: 1 as const, x: 700, y: 400 },
  ]
  it('flags caps beyond the ball and the second-last defender in the opponent half', () => {
    expect([...offsideCaps(0, caps, { x: 420, y: 310 }, 4)]).toEqual([3])
    expect([...offsideCaps(0, caps, { x: 900, y: 310 }, 4)]).toEqual([]) // ball is further forward
  })
  it('a pass to an offside cap is whistled', () => {
    const t = tracker(cap(4, 0), rules({ offside: true }), newPossession(), new Set([3]))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, T(cap(3, 0)), 880, 100))
    expect(t.resolve()).toMatchObject({ kind: 'freekick', next: 1, reason: 'offside' })
  })
  it('ignored when the ruleset has offside off', () => {
    const t = tracker(cap(4, 0), rules({ offside: false }), newPossession(), new Set([3]))
    t.onContact(hit(T(cap(4, 0)), BALL))
    t.onContact(hit(BALL, T(cap(3, 0))))
    expect(t.resolve().kind).toBe('normal')
  })
})

describe('set pieces', () => {
  const caps = Array.from({ length: 10 }, (_, id) => ({ id, team: (id < 5 ? 0 : 1) as 0 | 1, slot: id % 5, type: 'standard' as const, x: 480 + (id % 5) * 8, y: 280 + id * 4, active: true }))
  it('free kick: defenders retreat to the wall distance, nothing overlaps', () => {
    const r = rules()
    const t = setPieceTargets({ kind: 'freekick', next: 0, at: { x: 500, y: 300 }, reason: 'freekick' }, caps, { x: 0, y: 0 }, r)!
    for (const c of caps.filter(c => c.team === 1)) {
      const p = t.caps[c.id]
      expect(Math.hypot(p.x - t.ball.x, p.y - t.ball.y)).toBeGreaterThanOrEqual(r.wallDistance)
    }
  })
  it('penalty: ball on the spot, keeper on the line, taker behind the ball', () => {
    const t = setPieceTargets({ kind: 'penalty', next: 0, end: 1 }, caps, { x: 0, y: 0 }, rules())!
    expect(t.ball).toEqual({ x: PITCH.width - PITCH.penaltySpot, y: PITCH.height / 2 })
    expect(t.caps[5].x).toBeGreaterThan(PITCH.width - 40)
    expect(t.caps[4].x).toBeLessThan(t.ball.x)
    for (const c of caps) if (c.id !== 5 && c.id !== 4) expect(inPenaltyBox(t.caps[c.id], 1)).toBe(false)
  })
  it('goal kick: every cap slides back to its original formation, ball clear of caps', () => {
    const t = setPieceTargets({ kind: 'goalkick', next: 0, end: 0, at: { x: -5, y: 100 } }, caps, { x: 0, y: 0 }, rules())!
    for (const c of caps) expect(t.caps[c.id]).toEqual(basePosition(c.team, c.slot))
    expect(t.ball.x).toBeLessThan(PITCH.width / 4)
    for (const c of caps) expect(Math.hypot(t.caps[c.id].x - t.ball.x, t.caps[c.id].y - t.ball.y)).toBeGreaterThan(22 + 12)
  })
})

describe('cap types & surfaces (real physics)', () => {
  const slide = (surface: SurfaceId, slot: number, power = 0.6, dir = { x: 1, y: 0 }) => {
    const m = new Match({ ruleset: RULESETS.street, surface })
    m.world.caps.forEach((b, i) => { if (i !== slot) m.world.place(b, { x: 900 + (i % 2) * 50, y: 40 + i * 55 }) })
    m.world.place(m.world.ball, { x: 975, y: 590 })
    m.world.place(m.world.caps[slot], { x: 100, y: 310 })
    m.tryFlick(slot, dir, power)
    run(m, 20000, () => m.phase !== 'moving')
    const p = { ...m.world.caps[slot].position }
    m.destroy()
    return { dx: p.x - 100, dy: p.y - 310 }
  }
  it('heavy defender is heaviest, winger lightest', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const mass = (slot: number) => m.world.caps[slot].mass
    expect(mass(1)).toBeGreaterThan(mass(4))
    expect(mass(4)).toBeGreaterThan(mass(3))
    m.destroy()
  })
  it('slippery winger slides further than the sticky keeper', () => {
    expect(slide('park', 3).dx).toBeGreaterThan(slide('park', 0).dx * 2)
  })
  it('the slippery court is slipperier than the dusty lot', () => {
    expect(slide('court', 4, 0.4).dx).toBeGreaterThan(slide('dusty', 4, 0.4).dx * 1.6)
  })
  it('the hill bends rolling caps toward the bottom touchline', () => {
    expect(slide('slope', 4, 0.5).dy).toBeGreaterThan(8)
    expect(Math.abs(slide('park', 4, 0.5).dy)).toBeLessThan(1)
  })
})

describe('match integration (real physics)', () => {
  it('ball bounced off the board back onto your own cap gives a bonus flick', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    m.world.caps.forEach((b, i) => m.world.place(b, { x: 150 + i * 75, y: 560 }))
    m.world.place(m.world.ball, { x: 500, y: 90 })
    m.world.place(m.world.caps[4], { x: 500, y: 150 })
    m.world.place(m.world.caps[3], { x: 470, y: 230 })
    const turns: string[] = []
    m.events.on('turn', t => turns.push(`${t.team}:${t.reason}`))
    m.tryFlick(4, { x: 0, y: -1 }, 0.45)
    run(m, 15000, () => m.phase === 'aim')
    expect(turns.at(-1)).toBe('0:bonus')
    m.destroy()
  })
  it('an armed power shot hits harder and is consumed', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const speed = (arm: boolean) => {
      m.restart()
      m.possession.powerReady[0] = arm
      if (arm) expect(m.toggleArm()).toBe(true)
      m.tryFlick(1, { x: 0, y: 1 }, 0.7)
      const s = m.world.caps[1].speed
      run(m, 15000, () => m.phase !== 'moving')
      return s
    }
    const normal = speed(false)
    const power = speed(true)
    expect(power / normal).toBeCloseTo(RULESETS.street.combos.powerMultiplier, 3)
    expect(m.possession.powerReady[0]).toBe(false)
    m.destroy()
  })
  it('timed halves: half time then full time, clock only runs in live turns', () => {
    const r: Ruleset = { ...RULESETS.proper, halves: { count: 2, seconds: 2 } }
    const m = new Match({ ruleset: r, surface: 'park' })
    const halves: number[] = []
    let win: { team: number | null } | null = null
    m.events.on('half', h => halves.push(h.half))
    m.events.on('win', w => { win = w })
    m.paused = true
    run(m, 5000)
    expect(m.clockMs).toBe(0)
    m.paused = false
    run(m, 2100, () => halves.length > 0)
    expect(halves).toEqual([2])
    run(m, 1500, () => m.phase === 'aim')
    expect(m.team).toBe(1) // other team kicks off the second half
    run(m, 2500, () => m.phase === 'over')
    expect(m.phase).toBe('over')
    expect(win).toEqual(expect.objectContaining({ team: null }))
    m.destroy()
  })
})
