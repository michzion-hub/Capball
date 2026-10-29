import { CAP_TYPES, INPUT, PITCH } from '../config/tuning'
import type { CapTypeId, SurfaceId } from '../config/tuning'
import type { FlickAim } from '../input/flick'
import type { TeamIndex } from '../physics/world'
import { SpriteCache, drawBallArt, drawCapArt, shade } from './capArt'
import type { TeamDesign } from './capArt'
import { drawGoals, drawPitch } from './surfaces'
import { View } from './view'

export interface CapView {
  x: number
  y: number
  angle: number
  team: TeamIndex
  slot: number
  type: CapTypeId
  active: boolean
}

export interface FrameState {
  caps: CapView[]
  ball: { x: number; y: number; angle: number }
  aim: FlickAim | null
  /** Team whose caps may be grabbed (glow). null = nobody. */
  pickTeam: TeamIndex | null
  /** Optional finer filter: only these caps glow (shootout taker/keeper). */
  pickable?: (capId: number) => boolean
  /** Drawing a slow-motion replay. */
  replay?: boolean
  /** Cap with an armed power shot glow. */
  powerShot: boolean
  /** Flicked cap this play, for the trail. */
  activeCap: number | null
  time: number
}

/** Optional overlay drawn in world space (particles etc.). */
export type WorldLayer = (ctx: CanvasRenderingContext2D, view: View) => void

export class Renderer {
  readonly view = new View()
  private ctx: CanvasRenderingContext2D
  private pitchLayer: HTMLCanvasElement | null = null
  private pitchKey = ''
  private sprites = new SpriteCache()
  private surface: SurfaceId = 'park'
  private designs: [TeamDesign, TeamDesign]
  private designKey = ''
  private ballRoll = 0
  private lastBall = { x: 0, y: 0 }
  shake = { x: 0, y: 0 }
  layers: WorldLayer[] = []
  overLayers: WorldLayer[] = []

  constructor(private readonly canvas: HTMLCanvasElement, designs: [TeamDesign, TeamDesign]) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.designs = designs
  }

  resize(cssW: number, cssH: number, topInset: number, bottomInset: number, extra?: { right: number; bottom: number }): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.view.resize(cssW, cssH, dpr, topInset, bottomInset, extra)
    this.sprites.setResolution(this.view.scale * dpr)
  }

  setSurface(id: SurfaceId): void { this.surface = id }

  setDesigns(d: [TeamDesign, TeamDesign]): void {
    this.designs = d
    const key = JSON.stringify(d)
    if (key !== this.designKey) { this.designKey = key; this.sprites.clear() }
  }

  private ensurePitch(): HTMLCanvasElement {
    const v = this.view
    const pxu = v.scale * v.dpr
    const key = `${this.surface}:${pxu.toFixed(4)}`
    if (this.pitchLayer && key === this.pitchKey) return this.pitchLayer
    const m = PITCH.viewMargin * 1.6
    const c = this.pitchLayer ?? document.createElement('canvas')
    c.width = Math.ceil((PITCH.width + 2 * m) * pxu)
    c.height = Math.ceil((PITCH.height + 2 * m) * pxu)
    const ctx = c.getContext('2d')!
    ctx.setTransform(pxu, 0, 0, pxu, m * pxu, m * pxu)
    drawPitch(ctx, this.surface)
    this.pitchLayer = c
    this.pitchKey = key
    return c
  }

  draw(s: FrameState): void {
    const ctx = this.ctx
    const v = this.view
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#18171b'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    v.apply(ctx, this.shake.x, this.shake.y)
    const layer = this.ensurePitch()
    const m = PITCH.viewMargin * 1.6
    ctx.drawImage(layer, -m, -m, layer.width / (v.scale * v.dpr), layer.height / (v.scale * v.dpr))

    for (const l of this.layers) l(ctx, v)

    // shadows
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    for (const c of s.caps) {
      if (!c.active) continue
      const r = CAP_TYPES[c.type].radius
      ctx.beginPath(); ctx.ellipse(c.x + 3, c.y + 4, r, r * 0.92, 0, 0, Math.PI * 2); ctx.fill()
    }
    ctx.beginPath(); ctx.ellipse(s.ball.x + 2.5, s.ball.y + 3, 12, 11, 0, 0, Math.PI * 2); ctx.fill()

    // pick glow for the team on turn
    if (s.pickTeam !== null && !s.aim) {
      const pulse = 0.5 + 0.5 * Math.sin(s.time / 220)
      s.caps.forEach((c, id) => {
        if (!c.active || c.team !== s.pickTeam || (s.pickable && !s.pickable(id))) return
        const r = CAP_TYPES[c.type].radius
        ctx.beginPath()
        ctx.arc(c.x, c.y, r + 5 + pulse * 3, 0, Math.PI * 2)
        ctx.strokeStyle = s.powerShot ? `rgba(255,120,30,${0.6 + pulse * 0.4})` : `rgba(255,255,255,${0.35 + pulse * 0.35})`
        ctx.lineWidth = s.powerShot ? 4 : 2.5
        ctx.setLineDash(s.powerShot ? [] : [6, 5])
        ctx.stroke()
        ctx.setLineDash([])
      })
    }

    // ball (visual roll from travel distance)
    const dx = s.ball.x - this.lastBall.x
    const dy = s.ball.y - this.lastBall.y
    const travel = Math.hypot(dx, dy)
    if (travel < 60) this.ballRoll += (travel / 12) * Math.sign(dx + dy || 1)
    this.lastBall = { x: s.ball.x, y: s.ball.y }
    const ballSprite = this.sprites.get('ball', 12, drawBallArt)
    this.blit(ballSprite, s.ball.x, s.ball.y, 12, s.ball.angle + this.ballRoll)

    // caps
    for (const c of s.caps) {
      if (!c.active) continue
      const d = this.designs[c.team]
      const r = CAP_TYPES[c.type].radius
      const key = `cap:${c.team}:${c.slot}:${c.type}`
      const sprite = this.sprites.get(key, r, (cx, rr) => drawCapArt(cx, rr, { primary: d.primary, secondary: d.secondary, pattern: d.pattern, number: d.numbers[c.slot] ?? String(c.slot + 1), type: c.type }))
      this.blit(sprite, c.x, c.y, r, c.angle, v.rotated ? Math.PI / 2 : 0)
    }

    drawGoals(ctx)

    if (s.aim) this.drawAim(s)

    for (const l of this.overLayers) l(ctx, v)

    if (s.replay) {
      // Old-telly look: warm wash + scanlines over the whole canvas.
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = 'rgba(255, 190, 90, 0.10)'
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
      ctx.fillStyle = 'rgba(0,0,0,0.10)'
      const step = Math.max(3, Math.round(3 * v.dpr))
      for (let y = 0; y < this.canvas.height; y += step * 2) ctx.fillRect(0, y, this.canvas.width, step)
    }
  }

  /** Draw a cached sprite centred at x,y. `counter` keeps numbers upright in portrait. */
  private blit(img: HTMLCanvasElement, x: number, y: number, r: number, angle: number, counter = 0): void {
    const ctx = this.ctx
    const size = (r + 4) * 2
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle + counter)
    ctx.drawImage(img, -size / 2, -size / 2, size, size)
    ctx.restore()
  }

  private drawAim(s: FrameState): void {
    const ctx = this.ctx
    const a = s.aim!
    const cap = s.caps[a.capId]
    const r = CAP_TYPES[cap.type].radius
    const { x, y } = a.origin
    const col = a.power < 0.5 ? '#9cff57' : a.power < 0.85 ? '#ffd23f' : '#ff4b2b'
    // min-drag ring
    ctx.beginPath()
    ctx.arc(x, y, INPUT.minDrag + r * 0.2, 0, Math.PI * 2)
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.setLineDash([])
    // rubber band back to the finger
    const pl = Math.min(a.drag, INPUT.maxDrag)
    const bx = x - a.dir.x * pl
    const by = y - a.dir.y * pl
    ctx.strokeStyle = 'rgba(20,20,20,0.55)'
    ctx.lineWidth = 3
    ctx.setLineDash([4, 6])
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by); ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.fillStyle = 'rgba(20,20,20,0.6)'; ctx.fill()
    if (cap.type !== 'standard') {
      ctx.save()
      ctx.translate(x, y)
      if (this.view.rotated) ctx.rotate(Math.PI / 2)
      ctx.font = '15px "Permanent Marker", cursive'
      ctx.textAlign = 'center'
      ctx.lineWidth = 4
      ctx.strokeStyle = '#151515'
      ctx.fillStyle = '#fff9ee'
      const label = CAP_TYPES[cap.type].label.toUpperCase()
      ctx.strokeText(label, 0, r + 30)
      ctx.fillText(label, 0, r + 30)
      ctx.restore()
    }
    if (!a.valid) return
    // arrow — bends with spin (a cue for the curl direction, not a trajectory prediction)
    const len = r + 24 + a.power * 190
    const bend = a.spin * 0.6
    const base = Math.atan2(a.dir.y, a.dir.x)
    const pts: { x: number; y: number }[] = []
    let px = x + a.dir.x * (r + 6)
    let py = y + a.dir.y * (r + 6)
    pts.push({ x: px, y: py })
    const segs = 14
    const segLen = (len - r - 6) / segs
    let heading = base
    for (let i = 1; i <= segs; i++) {
      const u = i / segs
      heading = base + bend * u * u
      px += Math.cos(heading) * segLen
      py += Math.sin(heading) * segLen
      pts.push({ x: px, y: py })
    }
    const ex = px
    const ey = py
    const hd = { x: Math.cos(heading), y: Math.sin(heading) }
    const path = () => { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y) }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#151515'
    ctx.lineWidth = 11
    path(); ctx.stroke()
    ctx.strokeStyle = s.powerShot ? '#ff7a1f' : col
    ctx.lineWidth = 6
    path(); ctx.stroke()
    const hx = -hd.y
    const hy = hd.x
    ctx.beginPath()
    ctx.moveTo(ex + hd.x * 20, ey + hd.y * 20)
    ctx.lineTo(ex + hx * 13, ey + hy * 13)
    ctx.lineTo(ex - hx * 13, ey - hy * 13)
    ctx.closePath()
    ctx.fillStyle = s.powerShot ? '#ff7a1f' : col
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = '#151515'
    ctx.stroke()
    // spin marker: a curved arrow round the cap, turning the way the cap will spin
    if (a.spin !== 0) {
      const sweep = Math.PI * (0.35 + 0.75 * Math.abs(a.spin))
      const cw = a.spin > 0
      const start = base + Math.PI + (cw ? -sweep / 2 : sweep / 2)
      const end = start + (cw ? sweep : -sweep)
      const rr = r + 22
      ctx.lineWidth = 7
      ctx.strokeStyle = '#151515'
      ctx.beginPath(); ctx.arc(x, y, rr, start, end, !cw); ctx.stroke()
      ctx.lineWidth = 4
      ctx.strokeStyle = '#7ef9ff'
      ctx.beginPath(); ctx.arc(x, y, rr, start, end, !cw); ctx.stroke()
      const tx = x + Math.cos(end) * rr
      const ty = y + Math.sin(end) * rr
      const tang = end + (cw ? Math.PI / 2 : -Math.PI / 2)
      ctx.beginPath()
      ctx.moveTo(tx + Math.cos(tang) * 10, ty + Math.sin(tang) * 10)
      ctx.lineTo(tx + Math.cos(tang + 2.4) * 8, ty + Math.sin(tang + 2.4) * 8)
      ctx.lineTo(tx + Math.cos(tang - 2.4) * 8, ty + Math.sin(tang - 2.4) * 8)
      ctx.closePath()
      ctx.fillStyle = '#7ef9ff'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#151515'
      ctx.stroke()
    }
    // power meter arc around the cap
    ctx.lineWidth = 7
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.arc(x, y, r + 12, -Math.PI / 2, Math.PI * 1.5); ctx.stroke()
    ctx.strokeStyle = col
    ctx.beginPath(); ctx.arc(x, y, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, a.power)); ctx.stroke()
    if (a.capped) {
      ctx.fillStyle = shade('#ff4b2b', 0.1)
      ctx.font = '18px Bangers, Impact, sans-serif'
      ctx.textAlign = 'center'
      ctx.save()
      ctx.translate(x, y - r - 28)
      if (this.view.rotated) ctx.rotate(Math.PI / 2)
      ctx.lineWidth = 4
      ctx.strokeStyle = '#151515'
      ctx.strokeText('MAX', 0, 0)
      ctx.fillText('MAX', 0, 0)
      ctx.restore()
    }
  }
}
