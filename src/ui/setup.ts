import { RULESETS, RULESET_ORDER, getRuleset } from '../config/rulesets'
import type { Ruleset } from '../config/rulesets'
import { AI, SURFACES } from '../config/tuning'
import type { AiLevel, SurfaceId } from '../config/tuning'
import { esc } from './ui'

/** Rule toggles exposed in the setup sheet; each maps onto one Ruleset field. */
export const FLAG_DEFS = [
  { key: 'capTypes', label: 'Cap types' },
  { key: 'spin', label: 'Spin flicks' },
  { key: 'boardBonus', label: 'Board bonus' },
  { key: 'combos', label: 'Pass combos' },
  { key: 'corners', label: 'Corners' },
  { key: 'freeKicks', label: 'Free kicks' },
  { key: 'penalties', label: 'Penalties' },
  { key: 'offside', label: 'Offside' },
  { key: 'halves', label: 'Timed halves' },
] as const
export type FlagKey = (typeof FLAG_DEFS)[number]['key']

export function flagValue(r: Ruleset, k: FlagKey): boolean {
  if (k === 'combos') return r.combos.enabled
  if (k === 'halves') return r.halves !== null
  return r[k]
}

/** Preset + per-flag overrides → the ruleset actually played. */
export function buildRuleset(presetId: string, overrides: Record<string, boolean>): Ruleset {
  const p = getRuleset(presetId)
  const r: Ruleset = { ...p, combos: { ...p.combos }, halves: p.halves ? { ...p.halves } : null }
  for (const def of FLAG_DEFS) {
    const v = overrides[def.key]
    if (v === undefined) continue
    if (def.key === 'combos') r.combos.enabled = v
    else if (def.key === 'halves') {
      r.halves = v ? (p.halves ?? { count: 2, seconds: 120 }) : null
      if (!v && r.goalsToWin === null) r.goalsToWin = 3
    } else r[def.key] = v
  }
  if (!r.freeKicks) r.penalties = false
  const changed = FLAG_DEFS.some(d => overrides[d.key] !== undefined && overrides[d.key] !== flagValue(p, d.key))
  if (changed) r.name = `${p.name} (custom)`
  return r
}

export function setupHtml(o: { title: string; sub: string; presetId: string; overrides: Record<string, boolean>; surface: SurfaceId; showRules: boolean; goLabel: string; showAi?: boolean; aiLevel?: AiLevel }): string {
  const r = buildRuleset(o.presetId, o.overrides)
  const presets = RULESET_ORDER.map(id => {
    const p = RULESETS[id]
    return `<button class="opt ${id === o.presetId ? 'is-on' : ''}" data-action="preset:${id}"><b>${esc(p.name)}</b><small>${esc(p.blurb)}</small></button>`
  }).join('')
  const flags = FLAG_DEFS.map(d => {
    const on = flagValue(r, d.key)
    const disabled = d.key === 'penalties' && !r.freeKicks
    return `<label><input type="checkbox" data-input="flag:${d.key}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}/> ${d.label}</label>`
  }).join('')
  const surfaces = (Object.keys(SURFACES) as SurfaceId[]).map(id => {
    const s = SURFACES[id]
    return `<button class="opt ${id === o.surface ? 'is-on' : ''}" data-action="surface:${id}"><b>${esc(s.name)}</b><small>${esc(s.blurb)}</small></button>`
  }).join('')
  const aiLevels = (Object.keys(AI.levels) as AiLevel[]).map(id => {
    const level = AI.levels[id]
    return `<button class="opt ${(o.aiLevel ?? 'medium') === id ? 'is-on' : ''}" data-action="ai-level:${id}"><b>${level.name}</b><small>${level.blurb}</small></button>`
  }).join('')
  return `
    <div class="tape tape-b"></div>
    <h2>${esc(o.title)}</h2>
    <p class="sub">${esc(o.sub)}</p>
    ${o.showAi ? `<div class="opt-group"><label>Pick your opponent</label><div class="opts">${aiLevels}</div></div>` : ''}
    ${o.showRules ? `
    <div class="opt-group"><label>Rules</label><div class="opts">${presets}</div>
      <div class="flags">${flags}</div>
      <p class="sub" style="margin:8px 0 0;font-size:13px">${r.goalsToWin ? `First to ${r.goalsToWin}` : ''}${r.goalsToWin && r.halves ? ' · ' : ''}${r.halves ? `${r.halves.count} × ${Math.round(r.halves.seconds / 60)} min halves` : ''}${r.combos.enabled ? ` · ${r.combos.passesForPowerShot} passes = power shot` : ''}</p>
    </div>` : ''}
    <div class="opt-group"><label>Pitch</label><div class="opts">${surfaces}</div></div>
    <div class="setup-actions">
      <button class="btn" data-action="go">${esc(o.goLabel)}</button>
      <button class="btn ghost small" data-action="editor">Design caps</button>
      <button class="chip" data-action="back">Back</button>
    </div>`
}
