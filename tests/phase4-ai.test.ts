import { describe, expect, it } from 'vitest'
import { AiBrain, captureBoard, makeRng } from '../src/ai/brain'
import { AI } from '../src/config/tuning'
import { RULESETS } from '../src/config/rulesets'
import { Match } from '../src/game/match'

describe('CAPBALL AI', () => {
  it('has three materially distinct, reproducible difficulty profiles', () => {
    expect(AI.levels.easy.candidates).toBeLessThan(AI.levels.medium.candidates)
    expect(AI.levels.medium.candidates).toBeLessThan(AI.levels.hard.candidates)
    expect(AI.levels.easy.aimNoise).toBeGreaterThan(AI.levels.medium.aimNoise)
    expect(AI.levels.medium.aimNoise).toBeGreaterThan(AI.levels.hard.aimNoise)
    const a = makeRng(0.43), b = makeRng(0.43)
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b))
  })

  it('rehearses a legal flick without mutating the live board, then returns an executable decision', async () => {
    const match = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const brain = new AiBrain(match.ruleset, 'park', 'easy', 0.23)
    const before = captureBoard(match)
    try {
      const candidates = brain.candidates(before)
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates.every(c => before.pickable.includes(c.capId) && c.power > 0 && c.power <= 1)).toBe(true)
      const one = brain.rehearse(before, candidates[0])
      expect(Number.isFinite(one)).toBe(true)
      expect(captureBoard(match)).toEqual(before)
      const decision = await brain.decide(before, () => false, 1)
      expect(decision).not.toBeNull()
      expect(decision!.rehearsed).toBeGreaterThan(0)
      expect(match.tryFlick(decision!.capId, decision!.dir, decision!.power, decision!.spin)).toBe(true)
      expect(match.phase).toBe('moving')
    } finally {
      match.destroy()
    }
  }, 20_000)
})
