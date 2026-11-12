import { describe, expect, it } from 'vitest'
import { isNetworkTeamDesign } from '../src/net/protocol'
import { PATTERNS } from '../src/render/capArt'
import { defaultTeam, sanitizeTeam } from '../src/store/settings'
import { colorsClash, resolveKits } from '../src/ui/editor'

const validDesign = {
  name: 'Gutter Kings',
  primary: '#ff5a1f',
  secondary: '#1b1b1b',
  pattern: PATTERNS[0],
  numbers: ['1', '4', '5', '7', '9'],
  capNames: ['Big Sal', 'Brick', 'Wardrobe', 'Greasy Joe', 'Rocket'],
}

describe('online crew design exchange', () => {
  it('accepts only bounded, correctly shaped crews on the wire', () => {
    expect(isNetworkTeamDesign(validDesign)).toBe(true)
    expect(isNetworkTeamDesign({ ...validDesign, name: 'x'.repeat(19) })).toBe(false)
    expect(isNetworkTeamDesign({ ...validDesign, primary: '#ff5a1fextra' })).toBe(false)
    expect(isNetworkTeamDesign({ ...validDesign, numbers: ['1', '2', '3', '4'] })).toBe(false)
    expect(isNetworkTeamDesign({ ...validDesign, capNames: [...validDesign.capNames.slice(0, 4), 'x'.repeat(15)] })).toBe(false)
    expect(isNetworkTeamDesign({ ...validDesign, numbers: [1, 2, 3, 4, 5] })).toBe(false)
    expect(isNetworkTeamDesign(null)).toBe(false)
  })

  it('sanitises hostile designs field by field instead of trusting them', () => {
    const fallback = defaultTeam(0)
    const clean = sanitizeTeam({
      name: '   ',
      primary: 'javascript:alert(1)',
      secondary: '#ABCDEF',
      pattern: 'not-a-pattern',
      numbers: ['1', '22', 'x', '@#', '9'],
      capNames: ['Big Sal', 'Brick', 'Wardrobe', 'Greasy Joe', 'Rocket Man Long'],
      extra: '<script>',
    }, 0)
    expect(clean.name).toBe(fallback.name)
    expect(clean.primary).toBe(fallback.primary)
    expect(clean.secondary).toBe('#ABCDEF')
    expect(clean.pattern).toBe(fallback.pattern)
    expect(clean.numbers).toEqual(['1', '22', 'x', '7', '9'])
    expect(clean.capNames[4]).toBe('Rocket Man Lon')
    expect('extra' in clean).toBe(false)
  })

  it('resolves clashing crews identically on both ends', () => {
    const home = { ...validDesign, primary: '#ff5a1f' }
    const away = { ...validDesign, name: 'Rooftop Rats', primary: '#ff5a1e' }
    expect(colorsClash([home, away])).toBe(true)
    const once = resolveKits(home, away)
    const twice = resolveKits(home, away)
    expect(once).toEqual(twice)
    expect(once[0]).toBe(home)
    expect(once[1].primary).not.toBe(away.primary)
  })
})
