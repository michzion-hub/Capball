import { describe, expect, it } from 'vitest'
import { Commentator } from '../src/audio/commentary'
import { RULESETS } from '../src/config/rulesets'
import { PITCH } from '../src/config/tuning'
import { Particles } from '../src/fx/effects'
import { Match } from '../src/game/match'
import { ReplayRecorder } from '../src/game/replay'
import { ShootoutScore, TAKER_ORDER } from '../src/game/shootout'
import { RIVAL_CREWS, Tournament } from '../src/game/tournament'
import { defaultTeam, loadSettings } from '../src/store/settings'
import { colorDistance, colorsClash, resolveKits } from '../src/ui/editor'

const FRAME = 1000 / 60
const run = (m: Match, ms: number, until?: () => boolean) => {
  for (let t = 0; t < ms; t += FRAME) { m.update(FRAME); if (until?.()) return t }
  return ms
}

describe('shootout scoring', () => {
  it('alternates kickers and rotates takers through the crew', () => {
    const s = new ShootoutScore(0)
    expect(s.kicker).toBe(0)
    expect(s.takerSlot(0)).toBe(TAKER_ORDER[0])
    s.record(true)
    expect(s.kicker).toBe(1)
    s.record(false)
    expect(s.kicker).toBe(0)
    expect(s.takerSlot(0)).toBe(TAKER_ORDER[1])
  })
  it('ends early once a team cannot catch up', () => {
    const s = new ShootoutScore(0)
    // 3-0 after three each: team 1 has 2 left, max 2 → decided.
    for (let i = 0; i < 3; i++) { s.record(true); s.record(false) }
    expect(s.winner).toBe(0)
  })
  it('goes to sudden death when level after five, decided only after equal kicks', () => {
    const s = new ShootoutScore(0)
    for (let i = 0; i < 5; i++) { s.record(true); s.record(true) }
    expect(s.winner).toBeNull()
    expect(s.suddenDeath).toBe(true)
    s.record(true)
    expect(s.winner).toBeNull() // team 1 still to kick
    s.record(false)
    expect(s.winner).toBe(0)
    s.record(true) // ignored after a winner
    expect(s.taken(0)).toBe(6)
  })
})

describe('shootout match (real physics)', () => {
  const kick = (m: Match, dir: { x: number; y: number }, power: number) => {
    expect(m.keeperSetting).toBe(true)
    m.slideKeeper(PITCH.height / 2 - 70) // keeper dives to the top corner
    m.keeperReady()
    expect(m.reason).toBe('shootout')
    expect(m.canPick(m.keeperId)).toBe(false)
    expect(m.tryFlick(m.takerId, dir, power)).toBe(true)
    run(m, 20000, () => m.phase === 'goal' || m.phase === 'reset' || m.phase === 'over')
  }
  it('only the taker may flick, goals and misses are recorded, then it finishes', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park', shootout: { first: 0 } })
    const kicks: boolean[] = []
    let winner: number | null = -1
    m.events.on('kick', k => kicks.push(k.scored))
    m.events.on('win', w => { winner = w.team })
    // Only the keeper's team may act first, and only by sliding.
    expect(m.team).toBe(1)
    expect(m.tryFlick(m.keeperId, { x: -1, y: 0 }, 1)).toBe(false)
    // Kick 1 (team 0): low and hard into the bottom corner → goal.
    kick(m, { x: 1, y: 0.18 }, 0.9)
    expect(kicks).toEqual([true])
    run(m, 5000, () => m.phase === 'aim')
    // Kick 2 (team 1): straight backwards → miss.
    kick(m, { x: -1, y: 0 }, 0.4)
    expect(kicks).toEqual([true, false])
    // Play out: team 0 scores, team 1 misses until decided.
    let guard = 0
    while (m.phase !== 'over' && guard++ < 20) {
      run(m, 5000, () => m.phase === 'aim')
      if ((m.phase as string) === 'over') break
      if (m.shootout!.kicker === 0) kick(m, { x: 1, y: 0.18 }, 0.9)
      else kick(m, { x: -1, y: 0 }, 0.4)
      if (m.phase === 'goal') m.finishGoal()
    }
    expect(m.phase).toBe('over')
    expect(winner).toBe(0)
    expect(m.shootout!.goals(0)).toBeGreaterThanOrEqual(3)
    m.destroy()
  })
  it('restart resets the shootout tally', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park', shootout: { first: 0 } })
    kick(m, { x: 1, y: 0.18 }, 0.9)
    m.finishGoal()
    m.restart()
    expect(m.shootout!.taken(0)).toBe(0)
    expect(m.keeperSetting).toBe(true)
    m.destroy()
  })
})

describe('tournament', () => {
  it('semis feed the final and a champion is crowned', () => {
    const t = new Tournament([defaultTeam(0), defaultTeam(1), ...RIVAL_CREWS])
    expect(t.next?.id).toBe('sf1')
    t.record('sf1', [3, 1], 0)
    expect(t.next?.id).toBe('sf2')
    t.record('sf2', [2, 2], 1, [4, 5])
    expect(t.next?.id).toBe('final')
    expect(t.ties[2].home).toBe(0)
    expect(t.ties[2].away).toBe(3)
    t.record('final', [1, 3], 1)
    expect(t.champion).toBe(3)
    expect(t.next).toBeNull()
    expect(() => t.record('final', [1, 0], 0)).toThrow()
  })
})

describe('replay recorder', () => {
  it('keeps a bounded ring buffer and interpolates poses', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const rec = new ReplayRecorder(m.world, 1, 2)
    m.onFixedStep = () => rec.record()
    m.tryFlick(4, { x: 1, y: 0 }, 0.8)
    run(m, 4000)
    expect(rec.frames).toBe(Math.ceil(rec.hz)) // capped at 1 s
    const clip = rec.clip(0.5)
    expect(clip.duration).toBeCloseTo(0.5, 1)
    const a = clip.pose(0, 4), b = clip.pose(clip.duration, 4), mid = clip.pose(clip.duration / 2, 4)
    expect(Number.isFinite(mid.x)).toBe(true)
    expect(Math.min(a.x, b.x) - 1e-3).toBeLessThanOrEqual(mid.x)
    m.destroy()
  })
  it('clips a window around a goal mark', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const rec = new ReplayRecorder(m.world, 3, 2)
    m.onFixedStep = () => rec.record()
    m.tryFlick(4, { x: 1, y: 0 }, 0.8)
    run(m, 1000)
    const mark = rec.mark()
    run(m, 1000)
    const clip = rec.clipAround(mark, 0.5, 0.25)
    expect(clip.frames).toBe(Math.ceil(0.5 * rec.hz) + Math.ceil(0.25 * rec.hz))
    // Far longer lead than buffered is clamped, never reads garbage.
    expect(rec.clipAround(mark, 99, 0).frames).toBeLessThanOrEqual(Math.ceil(3 * rec.hz))
    m.destroy()
  })
})

describe('commentary, kits, settings, particles', () => {
  it('fills in names and never repeats the same line twice in a row', () => {
    let i = 0
    const c = new Commentator(() => [0, 0, 0.5, 0.5][i++ % 4])
    const a = c.line('goal', { cap: 'Big Sal', team: 'Gutter Kings', score: '1–0' })
    const b = c.line('goal', { cap: 'Big Sal', team: 'Gutter Kings', score: '1–0' })
    expect(a).not.toBe(b)
    expect(a + b).toMatch(/Big Sal|Gutter Kings/)
    expect(a).not.toMatch(/\{/)
  })
  it('rate-limits low priority calls but lets big moments through', () => {
    const c = new Commentator()
    expect(c.call('pass', {}, 1000, 0)).not.toBeNull()
    expect(c.call('pass', {}, 1100, 0)).toBeNull()
    expect(c.call('goal', { cap: 'x', team: 'y', score: '1' }, 1150, 3)).not.toBeNull()
  })
  it('clashing crews get an alternate away kit', () => {
    const home = defaultTeam(0)
    const away = { ...defaultTeam(1), primary: '#ff6020', secondary: '#ffffff' }
    expect(colorsClash([home, away])).toBe(true)
    const [, fixed] = resolveKits(home, away)
    expect(colorDistance(home.primary, fixed.primary)).toBeGreaterThanOrEqual(110)
    expect(resolveKits(home, defaultTeam(1))[1]).toEqual(defaultTeam(1))
  })
  it('stored settings are sanitised field by field', () => {
    const bad = JSON.stringify({ sound: 'yes', teams: [{ name: '<b>x</b>'.repeat(10), primary: 'red', numbers: ['123', '$$'] }], flags: { corners: true, evil: 'x' } })
    const s = loadSettings({ getItem: () => bad })
    expect(s.sound).toBe(true)
    expect(s.teams[0].name.length).toBeLessThanOrEqual(18)
    expect(s.teams[0].primary).toBe(defaultTeam(0).primary)
    expect(s.teams[0].numbers[0]).toBe('12')
    expect(s.teams[0].numbers[1]).toBe(defaultTeam(0).numbers[1])
    expect(s.flags).toEqual({ corners: true })
    expect(loadSettings({ getItem: () => '{not json' }).ruleset).toBe('street')
  })
  it('particle pool never grows past its cap', () => {
    const p = new Particles(50)
    for (let i = 0; i < 20; i++) p.dust(0, 0, 10, '#fff')
    expect(p.count).toBe(50)
    for (let i = 0; i < 200; i++) p.update(1 / 60)
    expect(p.count).toBe(0)
  })
})
