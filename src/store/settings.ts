import { TEAM_DEFAULTS } from '../config/tuning'
import type { AiLevel } from '../config/tuning'
import { PATTERNS } from '../render/capArt'
import type { Pattern, TeamDesign } from '../render/capArt'

const KEY = 'capball.v1'

export interface Settings {
  sound: boolean
  commentary: boolean
  speech: boolean
  replays: boolean
  shake: boolean
  /** Developer tuning overlay (sliders, vectors, flick stats). */
  tuning: boolean
  teams: [TeamDesign, TeamDesign]
  ruleset: string
  surface: string
  flags: Record<string, boolean>
  aiLevel: AiLevel
}

const DEFAULT_CAP_NAMES: [string[], string[]] = [
  ['Big Sal', 'Brick', 'Wardrobe', 'Greasy Joe', 'Rocket'],
  ['Mitts', 'The Fridge', 'Tank', 'Slick Rick', 'Boom'],
]

export function defaultTeam(i: 0 | 1): TeamDesign {
  const d = TEAM_DEFAULTS[i]
  return { name: d.name, primary: d.primary, secondary: d.secondary, pattern: d.pattern, numbers: ['1', '4', '5', '7', '9'], capNames: [...DEFAULT_CAP_NAMES[i]] }
}

export function defaultSettings(): Settings {
  return { sound: true, commentary: true, speech: false, replays: true, shake: true, tuning: false, teams: [defaultTeam(0), defaultTeam(1)], ruleset: 'street', surface: 'park', flags: {}, aiLevel: 'medium' }
}

const HEX = /^#[0-9a-f]{6}$/i

/** Validate untrusted stored data field by field; anything bad falls back to defaults. */
export function sanitizeTeam(raw: unknown, i: 0 | 1): TeamDesign {
  const d = defaultTeam(i)
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Partial<TeamDesign>
  const str = (v: unknown, max: number, fb: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fb)
  return {
    name: str(r.name, 18, d.name),
    primary: typeof r.primary === 'string' && HEX.test(r.primary) ? r.primary : d.primary,
    secondary: typeof r.secondary === 'string' && HEX.test(r.secondary) ? r.secondary : d.secondary,
    pattern: PATTERNS.includes(r.pattern as Pattern) ? (r.pattern as Pattern) : d.pattern,
    numbers: d.numbers.map((n, k) => str(Array.isArray(r.numbers) ? r.numbers[k] : undefined, 2, n).replace(/[^0-9A-Za-z]/g, '') || n),
    capNames: d.capNames.map((n, k) => str(Array.isArray(r.capNames) ? r.capNames[k] : undefined, 14, n)),
  }
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  const d = defaultSettings()
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return d
    const p = JSON.parse(raw) as Partial<Settings>
    return {
      sound: typeof p.sound === 'boolean' ? p.sound : d.sound,
      commentary: typeof p.commentary === 'boolean' ? p.commentary : d.commentary,
      speech: typeof p.speech === 'boolean' ? p.speech : d.speech,
      replays: typeof p.replays === 'boolean' ? p.replays : d.replays,
      shake: typeof p.shake === 'boolean' ? p.shake : d.shake,
      tuning: typeof p.tuning === 'boolean' ? p.tuning : d.tuning,
      teams: [sanitizeTeam(p.teams?.[0], 0), sanitizeTeam(p.teams?.[1], 1)],
      ruleset: typeof p.ruleset === 'string' ? p.ruleset : d.ruleset,
      surface: typeof p.surface === 'string' ? p.surface : d.surface,
      flags: p.flags && typeof p.flags === 'object' ? Object.fromEntries(Object.entries(p.flags).filter(([, v]) => typeof v === 'boolean')) : {},
      aiLevel: p.aiLevel === 'easy' || p.aiLevel === 'hard' ? p.aiLevel : 'medium',
    }
  } catch {
    return d
  }
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(KEY, JSON.stringify(s)) } catch { /* private mode / quota */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}
