import { describe, expect, it } from 'vitest'
import { defaultSettings, loadSettings, saveSettings } from '../src/store/settings'
import type { Settings } from '../src/store/settings'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('persistent dark mode setting', () => {
  it('defaults to the printed daylight theme', () => {
    expect(defaultSettings().dark).toBe(false)
    expect(loadSettings(memory()).dark).toBe(false)
    expect(loadSettings(null).dark).toBe(false)
  })

  it('survives a save and reload', () => {
    const store = memory()
    const settings: Settings = { ...defaultSettings(), dark: true, sound: false, tutorialStep: 2 }
    saveSettings(settings, store)
    const loaded = loadSettings(store)
    expect(loaded.dark).toBe(true)
    expect(loaded.sound).toBe(false)
    expect(loaded.tutorialStep).toBe(2)
  })

  it('rejects a non-boolean stored value instead of half-applying the theme', () => {
    const store = memory()
    store.setItem('capball.v1', JSON.stringify({ dark: 'yes' }))
    expect(loadSettings(store).dark).toBe(false)
    store.setItem('capball.v1', JSON.stringify({ dark: true }))
    expect(loadSettings(store).dark).toBe(true)
    store.setItem('capball.v1', '{oops')
    expect(loadSettings(store).dark).toBe(false)
  })

  it('remembers the tournament variant and defaults to Local 2P', () => {
    expect(defaultSettings().tournamentAi).toBe(false)
    const store = memory()
    saveSettings({ ...defaultSettings(), tournamentAi: true }, store)
    expect(loadSettings(store).tournamentAi).toBe(true)
    store.setItem('capball.v1', JSON.stringify({ tournamentAi: 'yes' }))
    expect(loadSettings(store).tournamentAi).toBe(false)
  })
})
