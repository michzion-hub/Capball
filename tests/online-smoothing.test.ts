import { describe, expect, it } from 'vitest'
import { RULESETS } from '../src/config/rulesets'
import { Match } from '../src/game/match'
import { OnlineDiagnostics } from '../src/net/diagnostics'
import { RenderInterpolator, interpolatePose, wrapAngle } from '../src/net/smoothing'
import type { Pose } from '../src/net/smoothing'

describe('online diagnostics', () => {
  it('smooths round-trip samples and reports mean absolute jitter', () => {
    const d = new OnlineDiagnostics()
    expect(d.read().rttMs).toBeNull()
    d.rttSample(100)
    expect(d.read().rttMs).toBe(100)
    expect(d.read().jitterMs).toBeNull()
    d.rttSample(200)
    expect(d.read().rttMs).toBe(125)
    expect(d.read().jitterMs).toBe(100)
    d.rttSample(100)
    expect(d.read().rttMs).toBe(118.8)
    expect(d.read().jitterMs).toBe(100)
    d.rttSample(140)
    expect(d.read().rttMs).toBe(124.1)
    expect(d.read().jitterMs).toBe(85)
    d.rttSample(Number.NaN)
    expect(d.read().rttMs).toBe(124.1)
  })

  it('classifies snapshot order and counts gaps, stale packets and reconnects', () => {
    const d = new OnlineDiagnostics()
    expect(d.snapshot(1)).toBe('ok')
    expect(d.snapshot(2)).toBe('ok')
    expect(d.snapshot(5)).toBe('gap')
    expect(d.snapshot(5)).toBe('stale')
    expect(d.snapshot(4)).toBe('stale')
    expect(d.snapshot(6)).toBe('ok')
    d.reconnect()
    d.reconnect()
    expect(d.read()).toMatchObject({ seq: 6, gaps: 2, stale: 2, reconnects: 2 })
    d.reset()
    expect(d.read()).toMatchObject({ seq: -1, gaps: 0, stale: 0, reconnects: 2 })
  })

  it('clamps correction sizes and link labels to bounded values', () => {
    const d = new OnlineDiagnostics()
    d.correction(1.234)
    d.correction(9000)
    expect(d.read().corrections).toBe(2)
    expect(d.read().lastCorrectionPx).toBe(2000)
    expect(d.read().maxCorrectionPx).toBe(2000)
    d.setLink('x'.repeat(80))
    expect(d.read().link).toHaveLength(24)
  })
})

describe('render interpolation', () => {
  it('wraps angles and clamps pose interpolation', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(Math.PI * 2 + 1)).toBeCloseTo(1, 6)
    expect(wrapAngle(-Math.PI * 2 - 1)).toBeCloseTo(-1, 6)
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 6)
    const from = { x: 0, y: 0, angle: Math.PI - 0.1 }
    const to = { x: 10, y: 20, angle: -Math.PI + 0.1 }
    const mid = interpolatePose(from, to, 0.5)
    expect(mid.x).toBe(5)
    expect(mid.y).toBe(10)
    expect(Math.abs(mid.angle)).toBeGreaterThan(3)
    expect(interpolatePose(from, to, -1)).toEqual(from)
    expect(interpolatePose(from, to, 2)).toEqual({ x: 10, y: 20, angle: from.angle + wrapAngle(to.angle - from.angle) })
  })

  it('keeps the displayed pose continuous, then settles monotonically to the authority', () => {
    const s = new RenderInterpolator()
    const displayed: Pose = { x: 100, y: 50, angle: 0.4 }
    const authoritative: Pose = { x: 112, y: 56, angle: 0.55 }
    const owed = s.correct(3, displayed, authoritative)
    expect(owed).toBeCloseTo(Math.hypot(12, 6), 6)
    // Reconciliation must never jump the picture: immediately after the server state lands
    // the rendered pose is still exactly what the player was looking at.
    expect(s.apply(3, authoritative).x).toBeCloseTo(displayed.x, 6)
    expect(s.apply(3, authoritative).y).toBeCloseTo(displayed.y, 6)
    let previous = s.residualPx(3)
    for (let i = 0; i < 40; i++) {
      s.advance(16.7)
      const now = s.residualPx(3)
      expect(now).toBeLessThanOrEqual(previous + 1e-9)
      previous = now
    }
    expect(previous).toBe(0)
    expect(s.apply(3, authoritative)).toEqual(authoritative)
  })

  it('bounds large corrections and snaps teleports instead of smearing them', () => {
    const s = new RenderInterpolator({ snapPx: 320, maxResidualPx: 240 })
    expect(s.correct(0, { x: 300, y: 0, angle: 0 }, { x: 0, y: 0, angle: 0 })).toBe(240)
    expect(s.residualPx(0)).toBe(240)
    expect(s.correct(1, { x: 900, y: 0, angle: 0 }, { x: 0, y: 0, angle: 0 })).toBe(0)
    expect(s.residualPx(1)).toBe(0)
    expect(s.stats.snapped).toBe(1)
    // Settled offsets are dropped, not kept as floating-point dust.
    const s2 = new RenderInterpolator()
    s2.correct(2, { x: 0.2, y: 0, angle: 0 }, { x: 0, y: 0, angle: 0 })
    expect(s2.residualPx(2)).toBe(0)
  })

  it('keeps delayed, reordered and dropped snapshots bounded', () => {
    const d = new OnlineDiagnostics()
    const s = new RenderInterpolator({ snapPx: 160, maxResidualPx: 120 })
    let displayed: Pose = { x: 0, y: 0, angle: 0 }
    let authority: Pose = { x: 0, y: 0, angle: 0 }
    // Simulated 20 Hz snapshots with jitter, one duplicate and one dropped frame.
    const arrivals: Array<{ seq: number; stepPx: number; dtMs: number }> = [
      { seq: 1, stepPx: 9, dtMs: 42 },
      { seq: 2, stepPx: 9, dtMs: 67 },
      { seq: 3, stepPx: 9, dtMs: 31 },
      { seq: 3, stepPx: 9, dtMs: 8 },
      { seq: 5, stepPx: 18, dtMs: 92 },
      { seq: 6, stepPx: 9, dtMs: 38 },
    ]
    const seen: string[] = []
    const residuals: number[] = []
    for (const packet of arrivals) {
      seen.push(d.snapshot(packet.seq))
      if (seen[seen.length - 1] === 'stale') {
        // A stale duplicate is measured but never applied; the local sim still advances.
        displayed = { x: displayed.x + packet.dtMs * 0.15, y: displayed.y, angle: displayed.angle }
        s.advance(packet.dtMs)
        continue
      }
      // The local simulation runs at its own rate; the server pose is the ground truth.
      displayed = { x: displayed.x + packet.dtMs * 0.15, y: displayed.y, angle: displayed.angle }
      authority = { x: authority.x + packet.stepPx, y: authority.y, angle: authority.angle }
      const shown = s.apply(0, displayed)
      const owed = s.correct(0, shown, authority)
      expect(owed).toBeLessThanOrEqual(120)
      residuals.push(s.residualPx(0))
      s.advance(packet.dtMs)
    }
    expect(seen).toEqual(['ok', 'ok', 'ok', 'stale', 'gap', 'ok'])
    expect(d.read().stale).toBe(1)
    expect(d.read().gaps).toBe(1)
    expect(Math.max(...residuals)).toBeLessThanOrEqual(120)
    expect(s.stats.snapped).toBe(0)
  })
})

describe('predicted flick reconciliation', () => {
  it('applies the authoritative pose and score without duplicating the flick', () => {
    const m = new Match({ ruleset: RULESETS.street, surface: 'park' })
    const id = m.world.caps.findIndex((b, i) => m.world.isActive(b) && m.world.capInfo(i).team === 0 && m.canPick(i))
    expect(id).toBeGreaterThanOrEqual(0)
    expect(m.tryFlick(id, { x: 1, y: 0.2 }, 0.55)).toBe(true)
    m.update(80)
    // A second call with the same local prediction must be refused; the server echo is the only
    // other place this flick can execute, and the client suppresses that echo by action id.
    expect(m.tryFlick(id, { x: 1, y: 0.2 }, 0.55)).toBe(false)

    const s = new RenderInterpolator()
    const body = m.world.caps[id]
    const displayed = s.apply(id, { x: body.position.x, y: body.position.y, angle: body.angle })
    const bodies = m.world.snapshot()
    bodies.caps[id] = { ...bodies.caps[id], x: bodies.caps[id].x + 14, y: bodies.caps[id].y - 5 }
    m.applyAuthoritativeState({
      bodies,
      phase: 'moving',
      team: 0,
      reason: 'kickoff',
      turn: 1,
      flicks: 1,
      score: [0, 0],
      possession: { chain: [0, 0], powerReady: [false, false], lastCap: null },
      armed: null,
      activeCap: id,
    })
    expect(m.phase).toBe('moving')
    expect(m.team).toBe(0)
    expect(m.score.goals).toEqual([0, 0])

    const authoritative = { x: m.world.caps[id].position.x, y: m.world.caps[id].position.y, angle: m.world.caps[id].angle }
    const owed = s.correct(id, displayed, authoritative)
    expect(owed).toBeGreaterThan(0)
    expect(owed).toBeLessThanOrEqual(240)
    // Still the old picture this frame, then a monotone settle for the next frames.
    expect(s.apply(id, authoritative).x).toBeCloseTo(displayed.x, 6)
    for (let i = 0; i < 40; i++) s.advance(16.7)
    expect(s.residualPx(id)).toBe(0)
    expect(s.apply(id, authoritative)).toEqual(authoritative)
    m.destroy()
  })
})
