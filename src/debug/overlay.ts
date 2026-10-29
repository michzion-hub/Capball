import { CAP_TYPES } from '../config/tuning'
import type { Match } from '../game/match'
import type { Contact, Vec } from '../physics/world'
import type { View } from '../render/view'
import { TuningSession, buildCatalog, fmt } from './tunables'
import type { Tunable } from './tunables'

/** One flick, measured from release to settle. Distances in world units (pitch = 1000 × 620). */
export interface PlayStats {
  capId: number
  label: string
  power: number
  spin: number
  /** Launch speed, wu per second. */
  launch: number
  start: Vec
  dir: Vec
  capPath: Vec[]
  ballPath: Vec[]
  capDist: number
  ballDist: number
  maxImpact: number
  t0: number
  playMs: number | null
  /** Sideways distance of the cap's final spot from its launch line (+ = right of travel). */
  curl: number
  goal: boolean
}

interface Mark { x: number; y: number; impact: number; age: number }

let overlayCount = 0
export function activeOverlays(): number { return overlayCount }

/**
 * Developer overlay: live sliders over src/config/tuning.ts, per-flick measurements and
 * world-space debug drawing (velocity vectors, spin, traces, impact strengths).
 * Owns its DOM and listeners; attachMatch/detachMatch per match, destroy() removes everything.
 */
export class TuneOverlay {
  enabled = false
  open = false
  /** Called when the panel opens/closes so the host can re-fit the pitch around it. */
  onLayout: (() => void) | null = null
  drawVectors = true
  readonly el: HTMLElement
  private abort = new AbortController()
  private session = new TuningSession()
  private catalog: Tunable[] = []
  private match: Match | null = null
  private unsubs: (() => void)[] = []
  private play: PlayStats | null = null
  last: PlayStats | null = null
  private marks: Mark[] = []
  private lastT = 0
  private frames = 0
  private fpsT = 0
  private fps = 0
  private statsT = 0

  constructor(host: HTMLElement) {
    overlayCount++
    this.el = document.createElement('aside')
    this.el.className = 'tune'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Tuning overlay')
    host.appendChild(this.el)
    const signal = this.abort.signal
    this.el.addEventListener('input', e => this.onInput(e), { signal })
    this.el.addEventListener('click', e => this.onClick(e), { signal })
    window.addEventListener('keydown', e => {
      if (e.key === '`' && this.enabled) { e.preventDefault(); this.toggle() }
    }, { signal })
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.setOpen(false)
  }

  toggle(): void { this.setOpen(!this.open) }

  setOpen(open: boolean): void {
    this.open = open && this.enabled
    if (this.open) this.render()
    this.el.hidden = !this.open
    this.onLayout?.()
  }

  /** Space the open panel takes: docked right on wide screens, a bottom sheet on narrow ones. */
  dock(): { right: number; bottom: number } {
    if (!this.open) return { right: 0, bottom: 0 }
    const narrow = window.matchMedia('(max-width: 640px)').matches
    return narrow ? { right: 0, bottom: this.el.offsetHeight + 4 } : { right: this.el.offsetWidth + 20, bottom: 0 }
  }

  attachMatch(m: Match): void {
    this.detachMatch()
    this.match = m
    this.play = null
    this.marks = []
    this.catalog = buildCatalog(m.world.surface.id, m.ruleset)
    this.session.track(this.catalog)
    this.unsubs.push(
      m.events.on('flick', f => this.onFlick(f.capId, f.power, f.spin)),
      m.events.on('step', () => this.onStep()),
      m.events.on('contact', c => this.onContact(c)),
      m.events.on('settled', s => this.finish(s.playMs, false)),
      m.events.on('goal', () => this.finish(performance.now() - (this.play?.t0 ?? performance.now()), true)),
    )
    if (this.open) this.render()
  }

  detachMatch(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.match = null
    this.play = null
  }

  get listenerCount(): number { return this.unsubs.length }

  destroy(): void {
    this.detachMatch()
    this.abort.abort()
    this.el.remove()
    overlayCount--
  }

  // ------------------------------------------------------------ measurement
  private onFlick(capId: number, power: number, spin: number): void {
    const m = this.match
    if (!m) return
    const b = m.world.caps[capId]
    const sp = Math.hypot(b.velocity.x, b.velocity.y) || 1
    const info = m.world.capInfo(capId)
    this.play = {
      capId, label: CAP_TYPES[info.type.id].label, power, spin,
      launch: sp * 60,
      start: { x: b.position.x, y: b.position.y },
      dir: { x: b.velocity.x / sp, y: b.velocity.y / sp },
      capPath: [{ x: b.position.x, y: b.position.y }],
      ballPath: [{ x: m.world.ball.position.x, y: m.world.ball.position.y }],
      capDist: 0, ballDist: 0, maxImpact: 0, t0: performance.now(), playMs: null, curl: 0, goal: false,
    }
    this.last = this.play
  }

  private onStep(): void {
    const p = this.play
    const m = this.match
    if (!p || !m || p.playMs !== null) return
    const add = (path: Vec[], pos: Vec): number => {
      const q = path[path.length - 1]
      const d = Math.hypot(pos.x - q.x, pos.y - q.y)
      if (d > 0.5) path.push({ x: pos.x, y: pos.y })
      return d > 0.5 ? d : 0
    }
    p.capDist += add(p.capPath, m.world.caps[p.capId].position)
    p.ballDist += add(p.ballPath, m.world.ball.position)
    if (p.capPath.length > 4000) p.capPath.splice(1, 1)
    if (p.ballPath.length > 4000) p.ballPath.splice(1, 1)
  }

  private onContact(c: Contact): void {
    if (this.play && this.play.playMs === null) this.play.maxImpact = Math.max(this.play.maxImpact, c.impact)
    if (this.enabled && c.impact > 0.8) {
      this.marks.push({ x: c.x, y: c.y, impact: c.impact, age: 0 })
      if (this.marks.length > 40) this.marks.shift()
    }
  }

  private finish(playMs: number, goal: boolean): void {
    const p = this.play
    const m = this.match
    if (!p || !m || p.playMs !== null) return
    p.playMs = playMs
    p.goal = goal
    const end = m.world.caps[p.capId].position
    p.curl = (end.x - p.start.x) * -p.dir.y + (end.y - p.start.y) * p.dir.x
    this.play = null
    if (this.open) this.renderStats()
  }

  // ------------------------------------------------------------ world drawing
  drawWorld(ctx: CanvasRenderingContext2D, view: View): void {
    const now = performance.now()
    const dt = this.lastT ? Math.min(100, now - this.lastT) : 16
    this.lastT = now
    this.frames++
    this.fpsT += dt
    if (this.fpsT >= 500) { this.fps = (this.frames * 1000) / this.fpsT; this.frames = 0; this.fpsT = 0 }
    if (this.open) { this.statsT += dt; if (this.statsT > 250) { this.statsT = 0; this.renderStats() } }
    const m = this.match
    if (!this.enabled || !this.drawVectors || !m) return
    const trace = this.play ?? this.last
    if (trace) {
      this.polyline(ctx, trace.ballPath, 'rgba(255,255,255,0.85)', [5, 5])
      this.polyline(ctx, trace.capPath, 'rgba(255,214,63,0.95)', [])
      // straight launch line, so curl is visible against it
      ctx.setLineDash([2, 6])
      ctx.strokeStyle = 'rgba(126,249,255,0.7)'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(trace.start.x, trace.start.y)
      ctx.lineTo(trace.start.x + trace.dir.x * Math.max(60, trace.capDist), trace.start.y + trace.dir.y * Math.max(60, trace.capDist)); ctx.stroke()
      ctx.setLineDash([])
    }
    for (const b of m.world.dynamic) {
      const s = b.speed
      if (s > 0.05) {
        const k = 9
        ctx.strokeStyle = '#ff2fd6'
        ctx.lineWidth = 2.5
        ctx.beginPath(); ctx.moveTo(b.position.x, b.position.y); ctx.lineTo(b.position.x + b.velocity.x * k, b.position.y + b.velocity.y * k); ctx.stroke()
        this.label(ctx, view, `${Math.round(s * 60)}`, b.position.x, b.position.y - 30, '#ff2fd6')
      }
      const w = b.angularVelocity
      if (Math.abs(w) > 0.01) {
        const r = (b.circleRadius ?? 12) + 6
        ctx.strokeStyle = '#7ef9ff'
        ctx.lineWidth = 2
        const sweep = Math.min(Math.PI * 1.6, Math.abs(w) * 12)
        ctx.beginPath(); ctx.arc(b.position.x, b.position.y, r, b.angle, b.angle + Math.sign(w) * sweep, w < 0); ctx.stroke()
      }
    }
    for (const mk of this.marks) {
      mk.age += dt
      const a = Math.max(0, 1 - mk.age / 1400)
      if (a <= 0) continue
      ctx.strokeStyle = `rgba(255,75,43,${a})`
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(mk.x, mk.y, 4 + mk.impact * 0.8, 0, Math.PI * 2); ctx.stroke()
      this.label(ctx, view, mk.impact.toFixed(1), mk.x + 10, mk.y - 10, `rgba(255,120,90,${a})`)
    }
    this.marks = this.marks.filter(mk => mk.age < 1400)
  }

  private polyline(ctx: CanvasRenderingContext2D, pts: Vec[], color: string, dash: number[]): void {
    if (pts.length < 2) return
    ctx.setLineDash(dash)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  private label(ctx: CanvasRenderingContext2D, view: View, text: string, x: number, y: number, color: string): void {
    ctx.save()
    ctx.translate(x, y)
    if (view.rotated) ctx.rotate(Math.PI / 2)
    ctx.font = 'bold 12px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, 0, 0)
    ctx.fillStyle = color
    ctx.fillText(text, 0, 0)
    ctx.restore()
  }

  // ------------------------------------------------------------ panel
  private render(): void {
    const groups = new Map<string, Tunable[]>()
    for (const t of this.catalog) {
      if (!groups.has(t.group)) groups.set(t.group, [])
      groups.get(t.group)!.push(t)
    }
    const changed = new Set(this.session.changes(this.catalog).map(c => c.id))
    const groupHtml = [...groups].map(([g, list], i) => `
      <details ${i < 3 ? 'open' : ''}><summary>${g}</summary>
        ${list.map(t => `<label class="tp ${changed.has(t.id) ? 'changed' : ''}" data-row="${t.id}">
          <span>${t.label}</span>
          <input type="range" data-tid="${t.id}" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.get()}" />
          <output>${fmt(t.get())}</output>
        </label>`).join('')}
      </details>`).join('')
    this.el.innerHTML = `
      <header><b>TUNING</b>
        <button data-t="vectors" class="${this.drawVectors ? 'on' : ''}">Vectors</button>
        <button data-t="export">Export</button>
        <button data-t="reset">Reset</button>
        <button data-t="close" aria-label="Close">×</button>
      </header>
      <div class="tstats" data-tstats></div>
      <textarea data-texport readonly hidden></textarea>
      <p class="tnote">Live, this session only. Export lists the changes to copy into <code>src/config/tuning.ts</code>.</p>
      ${groupHtml}`
    this.renderStats()
  }

  private renderStats(): void {
    const box = this.el.querySelector<HTMLElement>('[data-tstats]')
    if (!box) return
    const p = this.play ?? this.last
    const m = this.match
    const live = m ? m.world.maxSpeed() * 60 : 0
    const rows: [string, string][] = [['fps', this.fps.toFixed(0)], ['fastest body', `${live.toFixed(0)} wu/s`]]
    if (p) {
      rows.push(
        ['last flick', `${p.label}${p.goal ? ' · GOAL' : ''}`],
        ['power / spin', `${Math.round(p.power * 100)}% / ${p.spin === 0 ? 'none' : `${p.spin > 0 ? '↻' : '↺'} ${Math.round(Math.abs(p.spin) * 100)}%`}`],
        ['launch', `${p.launch.toFixed(0)} wu/s`],
        ['cap slid', `${p.capDist.toFixed(0)} wu`],
        ['off launch line', `${p.curl >= 0 ? '+' : ''}${p.curl.toFixed(0)} wu`],
        ['ball travelled', `${p.ballDist.toFixed(0)} wu`],
        ['hardest hit', p.maxImpact.toFixed(1)],
        ['time to settle', p.playMs === null ? 'moving…' : `${(p.playMs / 1000).toFixed(2)} s`],
      )
    } else rows.push(['last flick', 'flick a cap'])
    box.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement
    const id = el.dataset.tid
    if (!id) return
    const t = this.catalog.find(c => c.id === id)
    if (!t) return
    t.set(Number(el.value))
    if (t.retune) this.match?.world.retune()
    const row = el.closest('[data-row]')
    const out = row?.querySelector('output')
    if (out) out.textContent = fmt(t.get())
    const changed = this.session.changes(this.catalog).some(c => c.id === id)
    row?.classList.toggle('changed', changed)
  }

  private onClick(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]')
    if (!b) return
    const what = b.dataset.t
    if (what === 'close') this.setOpen(false)
    if (what === 'vectors') { this.drawVectors = !this.drawVectors; b.classList.toggle('on', this.drawVectors) }
    if (what === 'reset') { this.session.reset(this.catalog); this.match?.world.retune(); this.render() }
    if (what === 'export') {
      const ta = this.el.querySelector<HTMLTextAreaElement>('[data-texport]')!
      ta.value = this.session.exportText(this.catalog)
      ta.hidden = false
      ta.select()
      this.onLayout?.()
      navigator.clipboard?.writeText(ta.value).then(() => { b.textContent = 'Copied' }, () => { b.textContent = 'Select ↓' })
    }
  }
}
