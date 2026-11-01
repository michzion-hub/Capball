import { describe, expect, it } from 'vitest'
import { FOOTBALL } from '../src/config/football'
import { RULESETS } from '../src/config/rulesets'
import { BALL, CAP_TYPES, PITCH } from '../src/config/tuning'
import { HiddenPenalty, legalKeeperPosition } from '../src/game/penalty'
import { PlayTracker, newPossession } from '../src/game/play'
import { setPieceTargets } from '../src/game/setpieces'
import { basePosition } from '../src/game/formation'
import type { BodyTag, CapInfo, Contact, TeamIndex, Vec } from '../src/physics/world'

const cap = (id: number, team: TeamIndex, slot = id % 5): CapInfo => ({ id, team, slot, type: CAP_TYPES.standard })
const capTag = (value: CapInfo): BodyTag => ({ kind: 'cap', cap: value })
const ball: BodyTag = { kind: 'ball' }
const side: BodyTag = { kind: 'static', board: 'side', end: -1 }
const contact = (a: BodyTag, b: BodyTag, x = 500, y = 300): Contact => ({ a, b, x, y, impact: 5 })

function tracker(flicker = cap(4, 0), rules = RULESETS.street) {
  return new PlayTracker(flicker, rules, newPossession(), { touchingBallAtFlick: false, offsideAtFlick: new Set() })
}

describe('phone-first football rules', () => {
  it('awards a throw-in to the team that did not touch last and stops play immediately', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), ball))
    t.onContact(contact(ball, side, 500, 2))
    expect(t.take().some(e => e.type === 'whistle' && e.whistle.kind === 'throwin')).toBe(true)
    expect(t.resolve()).toMatchObject({ kind: 'throwin', next: 1, lastTeam: 0, at: { x: 500, y: 2 } })
  })

  it('awards the throw to team 0 when team 1 had the last cap touch', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), ball))
    t.onContact(contact(ball, capTag(cap(6, 1)), 520, 300))
    t.onContact(contact(ball, side, 520, PITCH.height - 1))
    expect(t.resolve()).toMatchObject({ kind: 'throwin', next: 0, lastTeam: 1 })
  })

  it('positions a throw-in without overlaps and retreats the defending team', () => {
    const caps = Array.from({ length: 10 }, (_, id) => ({
      id, team: (id < 5 ? 0 : 1) as TeamIndex, slot: id % 5,
      type: 'standard' as const, x: 500 + (id % 3) * 8, y: id < 5 ? 22 + id : 590 - id, active: true,
    }))
    const targets = setPieceTargets(
      { kind: 'throwin', next: 0, lastTeam: 1, at: { x: 500, y: 0 } },
      caps, { x: 0, y: 0 }, RULESETS.street,
    )!
    expect(targets.ball.y).toBeGreaterThan(BALL.radius)
    const taker = caps.find(c => c.team === 0 && c.slot === 3)!
    expect(Math.hypot(targets.caps[taker.id].x - targets.ball.x, targets.caps[taker.id].y - targets.ball.y)).toBeGreaterThanOrEqual(BALL.radius + CAP_TYPES.standard.radius)
    for (const c of caps.filter(c => c.team === 1)) {
      expect(Math.hypot(targets.caps[c.id].x - targets.ball.x, targets.caps[c.id].y - targets.ball.y)).toBeGreaterThanOrEqual(RULESETS.street.wallDistance + CAP_TYPES.standard.radius - 0.01)
    }
    for (let i = 0; i < caps.length; i++) {
      expect(Math.hypot(targets.caps[i].x - targets.ball.x, targets.caps[i].y - targets.ball.y)).toBeGreaterThanOrEqual(CAP_TYPES.standard.radius + BALL.radius - 0.01)
      for (let j = i + 1; j < caps.length; j++) {
        expect(Math.hypot(targets.caps[i].x - targets.caps[j].x, targets.caps[i].y - targets.caps[j].y)).toBeGreaterThanOrEqual(2 * CAP_TYPES.standard.radius - 0.01)
      }
    }
  })

  it('plays advantage when the victim touches the ball and makes clear forward progress', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), capTag(cap(6, 1)), 700, 300))
    t.onContact(contact(capTag(cap(6, 1)), ball, 600, 300))
    expect(t.resolve({ x: 530, y: 300 })).toMatchObject({ kind: 'normal', next: 1 })
    expect(t.advantageApplied).toBe(true)
  })

  it('calls the original foul when advantage produces no meaningful forward progress', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), capTag(cap(6, 1)), 700, 300))
    t.onContact(contact(capTag(cap(6, 1)), ball, 680, 300))
    expect(t.resolve({ x: 690, y: 300 })).toMatchObject({ kind: 'freekick', next: 1, at: { x: 700, y: 300 } })
    expect(t.advantageApplied).toBe(false)
  })

  it('does not keep advantage after the offender regains the ball', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), capTag(cap(6, 1)), 700, 300))
    t.onContact(contact(capTag(cap(6, 1)), ball, 620, 300))
    t.onContact(contact(capTag(cap(4, 0)), ball, 560, 300))
    expect(t.resolve({ x: 520, y: 300 })).toMatchObject({ kind: 'freekick', next: 1 })
  })

  it('resets goal-kick shape while keeping opponents outside the penalty area', () => {
    const caps = Array.from({ length: 10 }, (_, id) => ({
      id, team: (id < 5 ? 0 : 1) as TeamIndex, slot: id % 5,
      type: 'standard' as const, x: 430 + id * 5, y: 280 + id * 3, active: true,
    }))
    const targets = setPieceTargets(
      { kind: 'goalkick', next: 0, end: 0, at: { x: -10, y: 80 } },
      caps, { x: 0, y: 0 }, RULESETS.street,
    )!
    for (const c of caps.filter(c => c.team === 0)) expect(targets.caps[c.id]).toEqual(basePosition(c.team, c.slot))
    for (const c of caps.filter(c => c.team === 1)) {
      const p = targets.caps[c.id]
      expect(p.x).toBeGreaterThan(PITCH.penaltyBox.depth)
    }
    expect(targets.ball.x).toBeGreaterThan(0)
    expect(targets.ball.x).toBeLessThan(PITCH.penaltyBox.depth)
  })

  it('clamps keeper movement to the goal line by default and to the goal box when enabled', () => {
    const radius = CAP_TYPES.keeper.radius
    const line = legalKeeperPosition({ x: 200, y: -100 }, 0, radius, false)
    expect(line.x).toBeCloseTo(radius + FOOTBALL.keeperLineInset)
    expect(line.y).toBeGreaterThanOrEqual((PITCH.height - PITCH.goalWidth) / 2 + radius + FOOTBALL.keeperBoxInset)
    const box = legalKeeperPosition({ x: 500, y: 1000 }, 1, radius, true)
    expect(box.x).toBeGreaterThanOrEqual(PITCH.width - PITCH.goalBox.depth + radius + FOOTBALL.keeperBoxInset)
    expect(box.x).toBeLessThan(PITCH.width)
    expect(box.y).toBeLessThan((PITCH.height + PITCH.goalWidth) / 2)
  })
})

describe('local hidden penalty commit–reveal', () => {
  const shot = { direction: { x: 1, y: 0 }, power: 0.7 }

  it('keeps the keeper choice hidden until the shooter has locked a staged shot', () => {
    const p = new HiddenPenalty(0, 1, 4, 5, 1, 12_000)
    expect(p.dismissCover()).toBe(true)
    expect(p.lockKeeper({ x: 998, y: 280 })).toBe(true)
    expect(p.stage).toBe('cover-shooter')
    expect(p.dismissCover()).toBe(true)
    expect(p.stageShot(shot)).toBe(true)
    expect(p.committedShot).toBeNull()
    expect(p.lockShot()).toBe(true)
    expect(p.stage).toBe('reveal')
    expect(p.committedShot).toEqual(shot)
    expect(p.keeperPosition).toEqual({ x: 998, y: 280 })
  })

  it('uses the configured straight-shot default on timeout', () => {
    const p = new HiddenPenalty(0, 1, 4, 5, 1, 500)
    p.dismissCover(); p.lockKeeper({ x: 998, y: 310 }); p.dismissCover()
    expect(p.tick(501)).toBe(true)
    expect(p.timeoutShooter('straight', { direction: { x: 1, y: 0 }, power: 0.62 })).toBe(true)
    expect(p.committedShot?.power).toBe(0.62)
    expect(p.forfeited).toBe(false)
  })

  it('records a forfeit without creating a committed shooter direction', () => {
    const p = new HiddenPenalty(0, 1, 4, 5, 1, 500)
    p.dismissCover(); p.lockKeeper({ x: 998, y: 310 }); p.dismissCover()
    expect(p.timeoutShooter('forfeit', shot)).toBe(true)
    expect(p.forfeited).toBe(true)
    expect(p.committedShot).toBeNull()
  })

  it('sanitizes invalid directions and prevents locking an unstaged shot', () => {
    const p = new HiddenPenalty(0, 1, 4, 5, 1, 500)
    p.dismissCover(); p.lockKeeper({ x: 998, y: 310 }); p.dismissCover()
    expect(p.stageShot({ direction: { x: 0, y: 0 } as Vec, power: 0.5 })).toBe(false)
    expect(p.lockShot()).toBe(false)
  })
})
