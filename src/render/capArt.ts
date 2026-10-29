import type { CapTypeId } from '../config/tuning'

export type Pattern = 'solid' | 'stripes' | 'hoops' | 'split' | 'star' | 'checker' | 'bullseye'
export const PATTERNS: Pattern[] = ['solid', 'stripes', 'hoops', 'split', 'star', 'checker', 'bullseye']

export interface TeamDesign {
  name: string
  primary: string
  secondary: string
  pattern: Pattern
  numbers: string[]
  capNames: string[]
}

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)))
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

function crimp(ctx: CanvasRenderingContext2D, r: number, teeth = 21): void {
  ctx.beginPath()
  for (let i = 0; i <= teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2
    const rr = i % 2 === 0 ? r : r * 0.9
    const x = Math.cos(a) * rr
    const y = Math.sin(a) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function pattern(ctx: CanvasRenderingContext2D, p: Pattern, r: number, col: string): void {
  ctx.fillStyle = col
  switch (p) {
    case 'solid': break
    case 'stripes':
      for (let x = -r; x < r; x += r * 0.5) ctx.fillRect(x, -r, r * 0.22, r * 2)
      break
    case 'hoops':
      for (let y = -r; y < r; y += r * 0.5) ctx.fillRect(-r, y, r * 2, r * 0.22)
      break
    case 'split':
      ctx.fillRect(0, -r, r, r * 2)
      break
    case 'checker': {
      const s = r * 0.5
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if ((i + j) % 2 === 0) ctx.fillRect(-r + i * s, -r + j * s, s, s)
      break
    }
    case 'star': {
      ctx.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2
        const rr = i % 2 === 0 ? r * 0.95 : r * 0.42
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
      }
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'bullseye':
      ctx.lineWidth = r * 0.16
      ctx.strokeStyle = col
      for (const k of [0.35, 0.7]) { ctx.beginPath(); ctx.arc(0, 0, r * k, 0, Math.PI * 2); ctx.stroke() }
      break
  }
}

/** Small emblem showing the cap type (Phase 2). */
function emblem(ctx: CanvasRenderingContext2D, type: CapTypeId, r: number, ink: string): void {
  ctx.save()
  ctx.fillStyle = ink
  ctx.strokeStyle = ink
  ctx.lineWidth = r * 0.09
  ctx.lineJoin = 'round'
  const y = -r * 0.48
  const s = r * 0.24
  ctx.translate(0, y)
  ctx.beginPath()
  switch (type) {
    case 'defender': // shield
      ctx.moveTo(-s, -s * 0.9); ctx.lineTo(s, -s * 0.9); ctx.lineTo(s, 0); ctx.quadraticCurveTo(s * 0.8, s * 0.9, 0, s * 1.2); ctx.quadraticCurveTo(-s * 0.8, s * 0.9, -s, 0); ctx.closePath(); ctx.fill()
      break
    case 'winger': // lightning
      ctx.moveTo(s * 0.3, -s * 1.1); ctx.lineTo(-s * 0.7, s * 0.15); ctx.lineTo(0, s * 0.15); ctx.lineTo(-s * 0.3, s * 1.1); ctx.lineTo(s * 0.7, -s * 0.15); ctx.lineTo(0, -s * 0.15); ctx.closePath(); ctx.fill()
      break
    case 'keeper': // glove (palm + fingers)
      ctx.roundRect(-s * 0.85, -s * 0.2, s * 1.7, s * 1.2, s * 0.4); ctx.fill()
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.roundRect(-s * 0.85 + i * s * 0.45, -s * 1.05, s * 0.36, s * 0.95, s * 0.18); ctx.fill() }
      break
    case 'striker': // boot-star
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2
        const rr = i % 2 === 0 ? s * 1.15 : s * 0.5
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
      }
      ctx.closePath(); ctx.fill()
      break
    case 'standard':
      break
  }
  ctx.restore()
}

/**
 * Draws a bottle cap centred at 0,0 with radius r (in the context's units).
 * Crimped skirt, inner face with team pattern, stencil number, type emblem, top light.
 */
export function drawCapArt(ctx: CanvasRenderingContext2D, r: number, d: { primary: string; secondary: string; pattern: Pattern; number: string; type: CapTypeId }): void {
  // skirt
  crimp(ctx, r)
  const skirt = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r)
  skirt.addColorStop(0, shade(d.primary, 0.25))
  skirt.addColorStop(1, shade(d.primary, -0.45))
  ctx.fillStyle = skirt
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.05)
  ctx.strokeStyle = shade(d.primary, -0.65)
  ctx.stroke()
  // face
  const fr = r * 0.78
  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, fr, 0, Math.PI * 2)
  ctx.fillStyle = d.primary
  ctx.fill()
  ctx.clip()
  pattern(ctx, d.pattern, fr, d.secondary)
  ctx.restore()
  // rim groove
  ctx.beginPath()
  ctx.arc(0, 0, fr, 0, Math.PI * 2)
  ctx.lineWidth = r * 0.07
  ctx.strokeStyle = shade(d.primary, -0.35)
  ctx.stroke()
  // Type identity: each role gets its own rim so it reads at a glance.
  if (d.type === 'keeper') {
    // thick rubber gasket
    ctx.beginPath(); ctx.arc(0, 0, fr * 0.97, 0, Math.PI * 2)
    ctx.lineWidth = r * 0.17; ctx.strokeStyle = '#2b2b2b'; ctx.stroke()
    ctx.lineWidth = r * 0.04; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.stroke()
  } else if (d.type === 'defender') {
    // riveted steel ring
    ctx.beginPath(); ctx.arc(0, 0, fr * 0.96, 0, Math.PI * 2)
    ctx.lineWidth = r * 0.13; ctx.strokeStyle = '#a9adb3'; ctx.stroke()
    ctx.fillStyle = '#5d6168'
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.beginPath(); ctx.arc(Math.cos(a) * fr * 0.96, Math.sin(a) * fr * 0.96, r * 0.045, 0, Math.PI * 2); ctx.fill() }
  } else if (d.type === 'striker') {
    // gold rim
    ctx.beginPath(); ctx.arc(0, 0, fr * 0.97, 0, Math.PI * 2)
    ctx.lineWidth = r * 0.11; ctx.strokeStyle = '#ffd23f'; ctx.stroke()
    ctx.lineWidth = r * 0.03; ctx.strokeStyle = '#8a6a00'; ctx.stroke()
  } else if (d.type === 'winger') {
    // greasy speed streaks
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, fr, 0, Math.PI * 2); ctx.clip()
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineCap = 'round'
    for (const [o, w] of [[-0.35, 0.09], [-0.12, 0.05]] as const) {
      ctx.lineWidth = r * w; ctx.beginPath(); ctx.moveTo(-fr, fr * (o + 0.6)); ctx.lineTo(fr, fr * (o - 0.6)); ctx.stroke()
    }
    ctx.restore()
  }
  // number (stencil-ish)
  const ink = luminance(d.primary) > 0.6 && d.pattern === 'solid' ? '#151515' : '#fff9ee'
  const outline = ink === '#151515' ? '#fff9ee' : '#151515'
  ctx.font = `${Math.round(r * (d.type === 'standard' ? 0.95 : 0.78))}px Bangers, Impact, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const ny = d.type === 'standard' ? r * 0.06 : r * 0.2
  ctx.lineWidth = r * 0.16
  ctx.strokeStyle = outline
  ctx.lineJoin = 'round'
  ctx.strokeText(d.number, 0, ny)
  ctx.fillStyle = ink
  ctx.fillText(d.number, 0, ny)
  if (d.type !== 'standard') emblem(ctx, d.type, r, ink)
  // specular
  const spec = ctx.createRadialGradient(-r * 0.35, -r * 0.45, 0, -r * 0.35, -r * 0.45, r * 0.9)
  spec.addColorStop(0, 'rgba(255,255,255,0.45)')
  spec.addColorStop(0.5, 'rgba(255,255,255,0.06)')
  spec.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = spec
  ctx.fill()
}

export function drawBallArt(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(1, '#cfcac0')
  ctx.fillStyle = g
  ctx.fill()
  ctx.save()
  ctx.clip()
  ctx.fillStyle = '#1b1b1b'
  const pent = (cx: number, cy: number, s: number, rot: number) => {
    ctx.beginPath()
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2
      ctx.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s)
    }
    ctx.closePath()
    ctx.fill()
  }
  pent(0, 0, r * 0.36, -Math.PI / 2)
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2 + Math.PI / 5
    pent(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95, r * 0.3, a)
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.lineWidth = Math.max(1, r * 0.08)
  ctx.strokeStyle = '#2a2a2a'
  ctx.stroke()
}

/** Bitmap cache keyed by string; cleared when scale changes so sprites stay crisp. */
export class SpriteCache {
  private map = new Map<string, HTMLCanvasElement>()
  private pxPerUnit = 0

  setResolution(pxPerUnit: number): void {
    if (Math.abs(pxPerUnit - this.pxPerUnit) > 1e-3) { this.map.clear(); this.pxPerUnit = pxPerUnit }
  }

  get(key: string, r: number, draw: (ctx: CanvasRenderingContext2D, r: number) => void): HTMLCanvasElement {
    let c = this.map.get(key)
    if (c) return c
    const pad = 4
    const size = Math.ceil((r * 2 + pad * 2) * this.pxPerUnit)
    c = document.createElement('canvas')
    c.width = c.height = Math.max(2, size)
    const ctx = c.getContext('2d')!
    ctx.translate(size / 2, size / 2)
    ctx.scale(this.pxPerUnit, this.pxPerUnit)
    draw(ctx, r)
    this.map.set(key, c)
    return c
  }

  clear(): void { this.map.clear() }
}
