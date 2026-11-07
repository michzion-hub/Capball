import { describe, expect, it } from 'vitest'
import { makeRuleHint } from '../src/game/ruleHints'
import { TutorialProgress, TUTORIAL_COMPLETE_STEP } from '../src/game/tutorial'

describe('guided tutorial progression', () => {
  it('teaches flick, aim and settling in order using actual turn events', () => {
    const guide = new TutorialProgress()
    expect(guide.onFlick(1, false, 'standard')).toBe(false)
    expect(guide.step).toBe(0)
    expect(guide.onFlick(0, false, 'keeper')).toBe(true)
    expect(guide.step).toBe(1)
    expect(guide.onSettled()).toBe(false)
    expect(guide.onFlick(0, false, 'striker', 0.2)).toBe(false)
    expect(guide.snapshot().shortPullSeen).toBe(true)
    expect(guide.onFlick(0, false, 'striker', 0.8)).toBe(true)
    expect(guide.step).toBe(2)
    expect(guide.onSettled()).toBe(false)
    expect(guide.step).toBe(2)
    expect(guide.onFlick(0, false, 'striker', 0.5)).toBe(false)
    expect(guide.onSettled()).toBe(true)
    expect(guide.step).toBe(3)
  })

  it('requires a board contact play to settle before a separate board-bonus objective', () => {
    const guide = new TutorialProgress(3)
    expect(guide.onPlay({ type: 'boardHit', at: { x: 10, y: 20 } })).toBe(true)
    expect(guide.onPlay({ type: 'boardBonus', team: 0, capId: 1 })).toBe(false)
    expect(guide.snapshot().boardPhase).toBe('rebound')
    expect(guide.onSettled()).toBe(true)
    expect(guide.snapshot().boardPhase).toBe('bonus')
    expect(guide.onPlay({ type: 'boardBonus', team: 1, capId: 6 })).toBe(false)
    expect(guide.onPlay({ type: 'boardBonus', team: 0, capId: 1 })).toBe(true)
    expect(guide.step).toBe(4)
  })

  it('waits for three actual friendly passes and a real power-ready event', () => {
    const guide = new TutorialProgress(4)
    for (let i = 0; i < 2; i++) expect(guide.onPlay({ type: 'pass', team: 0, chain: i + 1, from: i, to: i + 1 })).toBe(true)
    expect(guide.snapshot().passes).toBe(2)
    expect(guide.onPlay({ type: 'powerReady', team: 1 })).toBe(false)
    expect(guide.step).toBe(4)
    expect(guide.onPlay({ type: 'pass', team: 0, chain: 3, from: 2, to: 3 })).toBe(true)
    expect(guide.onPlay({ type: 'powerReady', team: 0 })).toBe(true)
    expect(guide.step).toBe(5)
    expect(guide.onFlick(0, false, 'striker')).toBe(false)
    expect(guide.onFlick(0, true, 'striker')).toBe(true)
    expect(guide.step).toBe(6)
  })

  it('completes cap comparison only after two distinct types and supports retry/skip/resume', () => {
    const guide = new TutorialProgress(6)
    expect(guide.onFlick(0, false, 'winger')).toBe(false)
    expect(guide.onFlick(0, false, 'winger')).toBe(false)
    expect(guide.onFlick(0, false, 'defender')).toBe(true)
    expect(guide.step).toBe(TUTORIAL_COMPLETE_STEP)
    expect(new TutorialProgress(guide.step).complete).toBe(true)

    const retry = new TutorialProgress(4)
    retry.onPlay({ type: 'pass', team: 0, chain: 1, from: 0, to: 1 })
    retry.retry()
    expect(retry.snapshot().passes).toBe(0)
    expect(retry.skip()).toBe(true)
    expect(retry.step).toBe(5)
  })

  it('builds a concise referee card with cause, restart team and restriction', () => {
    expect(makeRuleHint('goalKick', 'Gutter Kings', 'Rooftop Rats', 'Rooftop Rats sent it over Gutter Kings’ end line.', 'Opponents wait outside the penalty area until the ball clears it.')).toEqual({
      key: 'goalKick',
      label: 'Goal kick',
      why: 'Rooftop Rats sent it over Gutter Kings’ end line.',
      restart: 'Gutter Kings restart with the ball in front of their keeper.',
      restriction: 'Opponents wait outside the penalty area until the ball clears it.',
    })
    expect(makeRuleHint('shootout', 'Rooftop Rats', 'Gutter Kings', 'The match is level.', 'The keeper sets on the line.')).toMatchObject({
      label: 'Penalty shootout',
      restart: 'Rooftop Rats take the next kick in the penalty shootout.',
      why: 'The match is level.',
    })
  })
})
