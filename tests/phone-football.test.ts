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
  it('keeps a long-side board hit in play and still awards a board-pass bonus', () => {
    const t = tracker()
    t.onContact(contact(capTag(cap(4, 0)), ball))
    t.onContact(contact(ball, side, 500, 2))
    expect(t.take().some(e => e.type === 'boardHit')).toBe(true)
    t.onContact(contact(ball, capTag(cap(5, 0)), 520, 300))
    expect(t.resolve()).toMatchObject({ kind: 'bonus', next: 0 })
  })

  it('does not whistle or award a restart when the ball hits a long-side board', () => {
    const t = tracker()
    t.onContact(contact(ball, side, 500, 2))
    expect(t.take().some(e => e.type === 'whistle')).toBe(false)
    expect(t.resolve()).toMatchObject({ kind: 'normal', next: 1 })
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

  it.each([0, 1] as const)('resets both formations and puts the ball ahead of the keeper at end %i', end => {
    const caps = Array.from({ length: 10 }, (_, id) => ({
      id, team: (id < 5 ? 0 : 1) as TeamIndex, slot: id % 5,
      type: 'standard' as const, x: 430 + id * 5, y: 280 + id * 3, active: true,
    }))
    const kicker = (end === 0 ? 0 : 1) as TeamIndex
    const targets = setPieceTargets(
      { kind: 'goalkick', next: kicker, end, at: { x: end === 0 ? -10 : PITCH.width + 10, y: 80 } },
      caps, { x: 0, y: 0 }, RULESETS.street,
    )!
    const keeper = caps.find(c => c.team === kicker && c.slot === 0)!
    const keeperAt = targets.caps[keeper.id]
    for (const c of caps) {
      if (c === keeper) continue
      expect(targets.caps[c.id]).toEqual(basePosition(c.team, c.slot))
    }
    const depthFromGoal = (x: number) => end === 0 ? x : PITCH.width - x
    const keeperDepth = depthFromGoal(keeperAt.x)
    const ballDepth = depthFromGoal(targets.ball.x)
    expect(targets.ball.y).toBeCloseTo(PITCH.height / 2)
    expect(ballDepth).toBeGreaterThan(keeperDepth)
    expect(ballDepth - keeperDepth).toBeCloseTo(CAP_TYPES[keeper.type].radius + BALL.radius + FOOTBALL.goalKickBallGap)
    expect(ballDepth).toBeLessThan(PITCH.goalBox.depth)
    expect(ballDepth).toBeLessThan(PITCH.penaltyBox.depth)
    for (const c of caps.filter(c => c.team !== kicker)) {
      const p = targets.caps[c.id]
      expect(end === 0 ? p.x : PITCH.width - p.x).toBeGreaterThan(PITCH.penaltyBox.depth)
    }
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
