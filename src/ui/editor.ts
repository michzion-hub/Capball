import { CAP_TYPES, LINEUP } from '../config/tuning'
import { PATTERNS, drawCapArt } from '../render/capArt'
import type { TeamDesign } from '../render/capArt'
import { esc } from './ui'

export const SWATCHES = ['#ff5a1f', '#e8262b', '#ff4fa3', '#9b5cff', '#1e9bff', '#19c3c3', '#2fbf71', '#b5e61d', '#ffd23f', '#ffffff', '#8a8f98', '#1b1b1b']

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Rough perceptual distance (weighted RGB). Below ~110 two crews become hard to tell apart. */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b)
  const rm = (r1 + r2) / 2
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export function colorsClash(teams: [TeamDesign, TeamDesign]): boolean {
  return colorDistance(teams[0].primary, teams[1].primary) < 110
}

/** If two crews clash, the away crew wears an alternate kit (swapped colours, else the most distant swatch). */
export function resolveKits(home: TeamDesign, away: TeamDesign): [TeamDesign, TeamDesign] {
  if (colorDistance(home.primary, away.primary) >= 110) return [home, away]
  if (colorDistance(home.primary, away.secondary) >= 110) return [home, { ...away, primary: away.secondary, secondary: away.primary }]
  const best = SWATCHES.reduce((p, c) => (colorDistance(home.primary, c) > colorDistance(home.primary, p) ? c : p))
  return [home, { ...away, primary: best }]
}

export function editorHtml(teams: [TeamDesign, TeamDesign]): string {
  const card = (t: TeamDesign, i: number) => {
    const sw = (field: 'primary' | 'secondary') => SWATCHES.map(c => `<button class="swatch" style="background:${c}" title="${c}" aria-label="${field} ${c}" data-action="swatch:${i}:${field}:${c}"></button>`).join('')
    const pats = PATTERNS.map(p => `<button class="opt ${p === t.pattern ? 'is-on' : ''}" data-action="pattern:${i}:${p}">${p}</button>`).join('')
    const caps = LINEUP.map((type, slot) => `
      <input class="num" type="text" inputmode="numeric" maxlength="2" value="${esc(t.numbers[slot])}" aria-label="${CAP_TYPES[type].label} number" data-input="team:${i}:num:${slot}"/>
      <input type="text" maxlength="14" value="${esc(t.capNames[slot])}" aria-label="${CAP_TYPES[type].label} name" placeholder="${CAP_TYPES[type].label}" data-input="team:${i}:cname:${slot}"/>`).join('')
    return `
      <div class="team-card" style="--team:${t.primary}">
        <div class="field">Crew name<input type="text" maxlength="18" value="${esc(t.name)}" data-input="team:${i}:name"/></div>
        <div class="preview">${LINEUP.map((_, slot) => `<canvas data-preview="${i}:${slot}" width="108" height="108"></canvas>`).join('')}</div>
        <div class="field">Main colour<div class="colors"><input type="color" value="${t.primary}" data-input="team:${i}:primary"/><div class="swatches">${sw('primary')}</div></div></div>
        <div class="field">Second colour<div class="colors"><input type="color" value="${t.secondary}" data-input="team:${i}:secondary"/><div class="swatches">${sw('secondary')}</div></div></div>
        <div class="field">Pattern<div class="patterns">${pats}</div></div>
        <div class="field">Numbers &amp; names <small>(keeper, defender, defender, winger, striker)</small><div class="capnames">${caps}</div></div>
        <button class="chip" data-action="teamreset:${i}">Reset crew</button>
      </div>`
  }
  return `
    <div class="tape tape-a"></div>
    <h2>Cap workshop</h2>
    <p class="sub">Paint your crew. Names show up in the commentary.</p>
    <p class="warn" data-warn ${colorsClash(teams) ? '' : 'hidden'}>Those main colours are too close — nobody will know whose cap is whose. Pick something different.</p>
    <div class="editor-grid">${card(teams[0], 0)}${card(teams[1], 1)}</div>
    <div class="setup-actions"><button class="btn" data-action="editor-done">Done</button></div>`
}

/** Redraw the preview caps (cheap; called on every edit so typing never loses focus). */
export function drawPreviews(root: HTMLElement, teams: [TeamDesign, TeamDesign]): void {
  for (const c of root.querySelectorAll<HTMLCanvasElement>('canvas[data-preview]')) {
    const [i, slot] = c.dataset.preview!.split(':').map(Number)
    const t = teams[i]
    const type = LINEUP[slot]
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    const r = CAP_TYPES[type].radius
    const s = (c.width / 2 - 4) / 26
    ctx.setTransform(s, 0, 0, s, c.width / 2, c.height / 2)
    drawCapArt(ctx, r, { primary: t.primary, secondary: t.secondary, pattern: t.pattern, number: t.numbers[slot], type })
  }
  const warn = root.querySelector<HTMLElement>('[data-warn]')
  if (warn) warn.hidden = !colorsClash(teams)
}
