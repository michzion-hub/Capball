import { describe, expect, it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import { AI_RIVAL_CREWS, RIVAL_CREWS, Tournament, simulateAiTie } from '../src/game/tournament'
import { defaultTeam } from '../src/store/settings'
import { setupHtml } from '../src/ui/setup'

const crews = [defaultTeam(0), ...AI_RIVAL_CREWS]

describe('Versus-AI tournament', () => {
  it('puts the human crew in semi-final 1 and seeds the AI rivals on the other side', () => {
    const t = new Tournament(crews)
    expect(t.crews).toHaveLength(4)
    expect(t.crews[0].name).toBe(defaultTeam(0).name)
    expect(t.ties[0].home).toBe(0)
    expect(t.ties[0].away).toBe(2)
    expect(t.ties[1].home).toBe(1)
    expect(t.ties[1].away).toBe(3)
    expect(t.next?.id).toBe('sf1')
  })

  it('resolves an AI-only fixture deterministically for the same seed and tie', () => {
    const a = simulateAiTie(0x9e3779b9, 'sf2', crews[1], crews[3], RULESETS.street)
    const b = simulateAiTie(0x9e3779b9, 'sf2', crews[1], crews[3], RULESETS.street)
    expect(b).toEqual(a)
    // Simulating another tie first must not disturb this one.
    simulateAiTie(0x9e3779b9, 'final', crews[0], crews[2], RULESETS.street)
    expect(simulateAiTie(0x9e3779b9, 'sf2', crews[1], crews[3], RULESETS.street)).toEqual(a)
    const variants = new Set(Array.from({ length: 24 }, (_, i) =>
      JSON.stringify(simulateAiTie(0x9e3779b9 + i, 'sf2', crews[1], crews[3], RULESETS.street))))
    expect(variants.size).toBeGreaterThan(1)
  })

  it('stops target-goal ties at the target with a winning and losing side', () => {
    expect(RULESETS.street.goalsToWin).not.toBeNull()
    for (let seed = 1; seed <= 25; seed++) {
      const sim = simulateAiTie(seed, 'sf1', crews[0], crews[2], RULESETS.street)
      const target = RULESETS.street.goalsToWin!
      expect(sim.winnerSide === 0 ? sim.goals[0] : sim.goals[1]).toBe(target)
      expect(sim.winnerSide === 0 ? sim.goals[1] : sim.goals[0]).toBeLessThan(target)
      expect(sim.shootout).toBeUndefined()
    }
  })

  it('handles timed ties, including a drawn match decided by a shootout', () => {
    expect(RULESETS.proper.goalsToWin).toBeNull()
    let sawDraw = false
    for (let seed = 1; seed <= 200; seed++) {
      const sim = simulateAiTie(seed, 'sf2', crews[1], crews[3], RULESETS.proper)
      expect(sim.goals[0]).toBeGreaterThanOrEqual(0)
      expect(sim.goals[0]).toBeLessThanOrEqual(6)
      expect(sim.goals[1]).toBeGreaterThanOrEqual(0)
      expect(sim.goals[1]).toBeLessThanOrEqual(6)
      if (sim.goals[0] === sim.goals[1]) {
        sawDraw = true
        expect(sim.shootout).toBeDefined()
        expect(sim.shootout![0]).not.toBe(sim.shootout![1])
        expect(sim.winnerSide).toBe(sim.shootout![0] > sim.shootout![1] ? 0 : 1)
      } else {
        expect(sim.shootout).toBeUndefined()
        expect(sim.winnerSide).toBe(sim.goals[0] > sim.goals[1] ? 0 : 1)
      }
    }
    expect(sawDraw).toBe(true)
  })

  it('marks AI-resolved fixtures and advances both semis into the final', () => {
    const t = new Tournament(crews)
    t.record('sf2', [4, 2], 0, undefined, true)
    expect(t.ties[1].result?.simulated).toBe(true)
    t.record('sf1', [3, 1], 0)
    expect(t.ties[2].home).toBe(0)
    expect(t.ties[2].away).toBe(1)
    t.record('final', [2, 3], 1)
    expect(t.champion).toBe(1)
    expect(t.ties[2].result?.simulated).toBe(false)
  })

  it('keeps the original Local 2P rivals available for the passer-and-play bracket', () => {
    const local = new Tournament([defaultTeam(0), defaultTeam(1), ...RIVAL_CREWS])
    expect(local.crews).toHaveLength(4)
    expect(local.crews[2].name).toBe('Alley Cats')
    expect(local.crews[3].name).toBe('Concrete Cobras')
  })
})

describe('tournament setup choice', () => {
  const base = {
    title: 'Street tournament', sub: 'Four crews', presetId: 'street', overrides: {},
    surface: 'park' as const, showRules: true, goLabel: 'Draw the bracket', showTournament: true,
  }

  it('defaults to Local 2P and hides the AI difficulty picker', () => {
    const html = setupHtml({ ...base, tournamentAi: false, showAi: false, aiLevel: 'medium' })
    expect(html).toContain('data-tournament-choice')
    expect(html).toContain('<b>Local 2P</b>')
    expect(html).toContain('<b>Versus AI</b>')
    expect(html).toMatch(/class="opt is-on" data-action="tournament-ai:no"/)
    expect(html).not.toContain('data-action="ai-level:')
  })

  it('shows the existing difficulty choices when Versus AI is selected', () => {
    const html = setupHtml({ ...base, tournamentAi: true, showAi: true, aiLevel: 'hard', aiLabel: 'Pick the rival difficulty' })
    expect(html).toMatch(/class="opt is-on" data-action="tournament-ai:yes"/)
    expect(html).toContain('Pick the rival difficulty')
    expect(html).toContain('data-action="ai-level:easy"')
    expect(html).toContain('data-action="ai-level:medium"')
    expect(html).toMatch(/class="opt is-on" data-action="ai-level:hard"/)
  })
})
