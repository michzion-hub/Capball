import { describe, expect, it } from 'vitest'
import { SURFACE_IDS, SURFACES, isSurfaceId } from '../src/config/tuning'
import { setupHtml } from '../src/ui/setup'

describe('pitch roster', () => {
  it('offers at least six distinct pitches in a stable order', () => {
    expect(SURFACE_IDS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(SURFACE_IDS).size).toBe(SURFACE_IDS.length)
    for (const id of SURFACE_IDS) {
      expect(SURFACES[id].id).toBe(id)
      expect(SURFACES[id].name.trim()).not.toBe('')
      expect(SURFACES[id].blurb.trim()).not.toBe('')
    }
    expect(new Set(SURFACE_IDS.map(id => SURFACES[id].name)).size).toBe(SURFACE_IDS.length)
  })

  it('keeps every pitch inside the fair-play band (no free lunch surface)', () => {
    for (const id of SURFACE_IDS) {
      const s = SURFACES[id]
      expect(s.frictionScale).toBeGreaterThanOrEqual(0.45)
      expect(s.frictionScale).toBeLessThanOrEqual(1.35)
      expect(s.boardBounce).toBeGreaterThanOrEqual(0.25)
      expect(s.boardBounce).toBeLessThanOrEqual(0.9)
      expect(Math.abs(s.slope.x)).toBeLessThanOrEqual(3.2)
      expect(Math.abs(s.slope.y)).toBeLessThanOrEqual(3.2)
    }
  })

  it('only accepts known pitch ids from untrusted input', () => {
    expect(isSurfaceId('carpark')).toBe(true)
    for (const id of SURFACE_IDS) expect(isSurfaceId(id)).toBe(true)
    expect(isSurfaceId('moon')).toBe(false)
    expect(isSurfaceId('')).toBe(false)
    expect(isSurfaceId(null)).toBe(false)
    expect(isSurfaceId(7)).toBe(false)
  })

  it('renders every pitch as a selectable option in the normal setup sheet', () => {
    const html = setupHtml({
      title: 'Quick match', sub: 'Street rules', presetId: 'street', overrides: {},
      surface: 'carpark', showRules: true, goLabel: 'Kick off',
    })
    const listed = [...html.matchAll(/data-action="surface:([a-z]+)"/g)].map(m => m[1])
    expect(listed).toEqual(SURFACE_IDS)
    expect(html).toContain('<button class="opt is-on" data-action="surface:carpark">')
  })
})
