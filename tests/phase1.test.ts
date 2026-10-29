import { describe, expect, it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import { PITCH } from '../src/config/tuning'
import { Match } from '../src/game/match'
import { GoalLatch, goalCrossed, goalTargetWinner } from '../src/game/rules'
import { TurnMachine } from '../src/game/turns'
import { SettleDetector } from '../src/physics/settle'

const FRAME = 1000 / 60
function run(match: Match, ms: number, until?: () => boolean): number {
  let t = 0
  while (t < ms) {
    match.update(FRAME)
    t += FRAME
    if (until?.()) break
  }
  return t
}
const mid = PITCH.height / 2

describe('goal detection', () => {
  it('needs the whole ball over the line and between the posts', () => {
    expect(goalCrossed(-5, mid, 12)).toBe(-1) // still touching the line
    expect(goalCrossed(-13, mid, 12)).toBe(0)
    expect(goalCrossed(PITCH.width + 13, mid, 12)).toBe(1)
    expect(goalCrossed(-13, 40, 12)).toBe(-1) // wide of the posts
  })
  it('latch counts a goal exactly once per play', () => {
    const latch = new GoalLatch()
    expect(latch.check(-20, mid, 12)?.scorer).toBe(1)
    expect(latch.check(-25, mid, 12)).toBeNull()
    expect(latch.check(-20, mid, 12)).toBeNull()
    latch.reset()
    expect(latch.check(-20, mid, 12)?.scorer).toBe(1)
  })
  it('first to 3 wins', () => {
    expect(goalTargetWinner({ goals: [2, 2] }, { goalsToWin: 3 })).toBeNull()
    expect(goalTargetWinner({ goals: [3, 1] }, { goalsToWin: 3 })).toBe(0)
  })
})

describe('turn machine', () => {
  it('allows one flick per turn by the team on turn only', () => {
    const t = new TurnMachine(0)
    expect(t.flick(1)).toBe(false)
    expect(t.flick(0)).toBe(true)
    expect(t.flick(0)).toBe(false) // second flick in same turn
    expect(t.state.phase).toBe('moving')
  })
  it('changes turn only after settling', () => {
    const t = new TurnMachine(0)
    expect(t.settled(1, 'normal')).toBe(false) // nothing in motion yet
    t.flick(0)
    expect(t.canFlick(1)).toBe(false) // opponent cannot flick while moving
    expect(t.settled(1, 'normal')).toBe(true)
    expect(t.state).toMatchObject({ phase: 'aim', team: 1, flicks: 0 })
  })
})

describe('settle detector', () => {
  it('requires a continuous rest hold', () => {
    const s = new SettleDetector(100)
    expect(s.update(true, 60)).toBe(false)
    expect(s.update(false, 60)).toBe(false)
    expect(s.update(true, 60)).toBe(false)
    expect(s.update(true, 60)).toBe(true)
  })
})

describe('match (real physics)', () => {
  it('a flick slides, collides and settles naturally, then passes the turn', () => {
    const m = new Match({ ruleset: RULESETS.basic, surface: 'park' })
    const turns: number[] = []
    m.events.on('turn', e => turns.push(e.team))
    const striker = 4
    expect(m.tryFlick(striker, { x: 1, y: 0 }, 0.6)).toBe(true)
    expect(m.tryFlick(striker, { x: 1, y: 0 }, 0.6)).toBe(false)
    const start = m.world.caps[striker].position.x
    let sawMotion = false
    const t = run(m, 15000, () => {
      if (m.world.maxSpeed() > 1) sawMotion = true
      return m.phase === 'aim'
    })
    expect(sawMotion).toBe(true)
    expect(m.phase).toBe('aim')
    expect(m.team).toBe(1)
    expect(turns).toEqual([1])
    expect(m.world.isAtRest()).toBe(true)
    expect(t).toBeLessThan(8000)
    expect(m.world.caps[striker].position.x).not.toBe(start)
    m.destroy()
  })

  it('does not hand over the turn while anything is still moving', () => {
    const m = new Match({ ruleset: RULESETS.basic, surface: 'court' })
    m.tryFlick(4, { x: 1, y: 0.1 }, 1)
    for (let i = 0; i < 400; i++) {
      m.update(FRAME)
      if (m.phase === 'aim') break
      expect(m.team).toBe(0)
    }
    expect(m.world.isAtRest()).toBe(true)
    m.destroy()
  })

  it('counts a goal exactly once, celebrates, resets to kickoff for the conceding team', () => {
    const m = new Match({ ruleset: RULESETS.basic, surface: 'park' })
    // Line up a clean shot: ball near the right goal, team-0 striker behind it.
    m.world.place(m.world.ball, { x: PITCH.width - 60, y: mid })
    m.world.place(m.world.caps[4], { x: PITCH.width - 120, y: mid })
    for (let i = 5; i < 10; i++) m.world.place(m.world.caps[i], { x: 520, y: 40 + i * 50 })
    const goals: number[] = []
    m.events.on('goal', g => goals.push(g.scorer))
    m.tryFlick(4, { x: 1, y: 0 }, 0.9)
    run(m, 8000, () => m.phase === 'aim')
    expect(goals).toEqual([0])
    expect(m.score.goals).toEqual([1, 0])
    expect(m.phase).toBe('aim')
    expect(m.team).toBe(1) // conceding team kicks off
    expect(m.world.ball.position.x).toBeCloseTo(PITCH.width / 2, 3)
    m.destroy()
  })

  it('first to 3 ends the match with a winner', () => {
    const m = new Match({ ruleset: RULESETS.basic, surface: 'park' })
    let winner: number | null = -1
    m.events.on('win', w => { winner = w.team })
    for (let g = 0; g < 5 && m.phase !== 'over'; g++) {
      const team = m.team
      const capId = team === 0 ? 4 : 9
      const dir = team === 0 ? 1 : -1
      const goalX = team === 0 ? PITCH.width - 60 : 60
      for (let i = 0; i < 10; i++) m.world.place(m.world.caps[i], { x: 500, y: 30 + i * 56 })
      m.world.place(m.world.ball, { x: goalX, y: mid })
      m.world.place(m.world.caps[capId], { x: goalX - dir * 60, y: mid })
      m.tryFlick(capId, { x: dir, y: 0 }, 0.9)
      run(m, 9000, () => m.phase === 'aim' || m.phase === 'over')
    }
    expect(m.phase).toBe('over')
    expect(winner).not.toBe(-1)
    expect(Math.max(...m.score.goals)).toBe(3)
    expect(m.tryFlick(4, { x: 1, y: 0 }, 1)).toBe(false)
    m.destroy()
  })

  it('restart resets score, turn and positions without stacking listeners', () => {
    const m = new Match({ ruleset: RULESETS.basic, surface: 'park' })
    const before = m.world.caps.map(b => ({ ...b.position }))
    const listenersBefore = m.events.listenerCount()
    m.tryFlick(4, { x: 1, y: 0 }, 1)
    run(m, 600)
    m.score = { goals: [2, 1] }
    m.restart()
    expect(m.score.goals).toEqual([0, 0])
    expect(m.phase).toBe('aim')
    expect(m.team).toBe(0)
    m.world.caps.forEach((b, i) => {
      expect(b.position.x).toBeCloseTo(before[i].x, 5)
      expect(b.position.y).toBeCloseTo(before[i].y, 5)
      expect(b.speed).toBeLessThan(1e-6)
    })
    for (let i = 0; i < 5; i++) m.restart()
    expect(m.events.listenerCount()).toBe(listenersBefore)
    m.destroy()
  })
})
