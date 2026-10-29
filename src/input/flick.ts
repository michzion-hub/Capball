import { INPUT } from '../config/tuning'
import type { Vec } from '../physics/world'
import type { View } from '../render/view'

export interface FlickAim {
  capId: number
  /** Cap centre (world). */
  origin: Vec
  /** Pointer position (world). */
  pointer: Vec
  /** Unit flick direction (opposite the drag). */
  dir: Vec
  /** Raw drag length (world units). */
  drag: number
  /** 0..1, clamped at the power cap. */
  power: number
  /** False while under the minimum drag — releasing cancels. */
  valid: boolean
  capped: boolean
  /** -1..1 spin from an off-centre grab (+ = clockwise on screen → curls right). 0 when spin is off. */
  spin: number
  /** Where the cap was grabbed, relative to its centre (world). */
  grab: Vec
  /** Grab radius used to normalise spin (cap radius + finger slop). */
  grabR: number
}

/**
 * Spin from an off-centre grab. Grabbing the cap right of the line of travel makes it spin
 * anticlockwise (like striking a disc off-centre), so it curls left — it always curls the way it spins.
 * Grabs within the dead zone of the centre are dead straight.
 */
export function computeSpin(dir: Vec, grab: Vec, capR: number, grabR: number): number {
  const lateral = grab.x * -dir.y + grab.y * dir.x // + = right of travel (screen, y down)
  const dead = capR * INPUT.spinDeadzone
  const span = Math.max(1, grabR - dead)
  const mag = Math.min(1, Math.max(0, (Math.abs(lateral) - dead) / span))
  return mag === 0 ? 0 : -Math.sign(lateral) * mag
}

/** Pure flick math: drag back from the cap, flick goes the other way. */
export function computeFlick(origin: Vec, pointer: Vec, maxDrag: number = INPUT.maxDrag): Pick<FlickAim, 'dir' | 'drag' | 'power' | 'valid' | 'capped'> {
  const dx = origin.x - pointer.x
  const dy = origin.y - pointer.y
  const drag = Math.hypot(dx, dy)
  const valid = drag >= INPUT.minDrag
  const span = maxDrag - INPUT.minDrag
  const power = valid ? Math.min(1, (drag - INPUT.minDrag) / span) : 0
  const dir = drag > 1e-6 ? { x: dx / drag, y: dy / drag } : { x: 0, y: 0 }
  return { dir, drag, power, valid, capped: drag >= maxDrag }
}

export interface Pickable { id: number; x: number; y: number; r: number }

export interface FlickHooks {
  /** Caps the player may grab right now (empty when it isn't their turn). */
  pickable(): Pickable[]
  onAim(aim: FlickAim | null): void
  onFlick(capId: number, dir: Vec, power: number, spin: number): void
  /** Whether off-centre grabs add spin (ruleset). */
  spinEnabled?(): boolean
  /** Optional tap anywhere that isn't a cap (used to skip replays). */
  onTap?(): void
}

let attachedCount = 0
/** Live input handler count — used by tests to prove no duplicate handlers. */
export function activeInputHandlers(): number { return attachedCount }

/**
 * Pointer Events cover mouse, pen and touch with one code path.
 * All listeners hang off one AbortController, so detach() removes every one of them.
 */
export class FlickInput {
  private abort: AbortController | null = null
  private pointerId: number | null = null
  private aim: FlickAim | null = null
  private downAt: Vec | null = null

  constructor(private readonly canvas: HTMLCanvasElement, private readonly view: View, private readonly hooks: FlickHooks) {}

  get attached(): boolean { return this.abort !== null }

  attach(): void {
    if (this.abort) return // idempotent: never double-bind
    this.abort = new AbortController()
    attachedCount++
    const signal = this.abort.signal
    const c = this.canvas
    c.addEventListener('pointerdown', e => this.down(e), { signal })
    c.addEventListener('pointermove', e => this.move(e), { signal })
    c.addEventListener('pointerup', e => this.up(e), { signal })
    c.addEventListener('pointercancel', () => this.cancel(), { signal })
    c.addEventListener('lostpointercapture', () => this.cancel(), { signal })
    c.addEventListener('contextmenu', e => e.preventDefault(), { signal })
    // Block page scroll / pull-to-refresh / pinch while playing.
    const block = (e: Event) => { if (e.cancelable) e.preventDefault() }
    c.addEventListener('touchstart', block, { signal, passive: false })
    c.addEventListener('touchmove', block, { signal, passive: false })
    document.addEventListener('gesturestart', block, { signal })
    window.addEventListener('keydown', e => { if (e.key === 'Escape') this.cancel() }, { signal })
  }

  detach(): void {
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    attachedCount--
    this.cancel()
  }

  /** Force-cancel any in-progress drag (turn changed, menu opened…). */
  cancel(): void {
    if (this.pointerId !== null) {
      try { this.canvas.releasePointerCapture(this.pointerId) } catch { /* already released */ }
    }
    this.pointerId = null
    this.downAt = null
    if (this.aim) { this.aim = null; this.hooks.onAim(null) }
  }

  private spinFor(dir: Vec, grab: Vec, capR: number, grabR: number): number {
    if (this.hooks.spinEnabled && !this.hooks.spinEnabled()) return 0
    return computeSpin(dir, grab, capR, grabR)
  }

  private local(e: PointerEvent): Vec {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private down(e: PointerEvent): void {
    if (this.pointerId !== null) return // ignore second finger
    if (e.pointerType === 'mouse' && e.button !== 0) { this.cancel(); return }
    e.preventDefault()
    const sp = this.local(e)
    const wp = this.view.toWorld(sp)
    const slopPx = e.pointerType === 'touch' ? INPUT.touchPickSlopPx : INPUT.mousePickSlopPx
    const slop = slopPx / this.view.scale
    let best: Pickable | null = null
    let bestD = Infinity
    for (const p of this.hooks.pickable()) {
      const d = Math.hypot(p.x - wp.x, p.y - wp.y)
      if (d <= p.r + slop && d < bestD) { best = p; bestD = d }
    }
    this.downAt = sp
    this.pointerId = e.pointerId
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
    if (!best) return
    const origin = { x: best.x, y: best.y }
    const grab = { x: wp.x - best.x, y: wp.y - best.y }
    const grabR = best.r + slop
    const f = computeFlick(origin, wp)
    this.aim = { capId: best.id, origin, pointer: wp, ...f, grab, grabR, capR: best.r, spin: this.spinFor(f.dir, grab, best.r, grabR) } as FlickAim
    this.hooks.onAim(this.aim)
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId || !this.aim) return
    e.preventDefault()
    const wp = this.view.toWorld(this.local(e))
    const f = computeFlick(this.aim.origin, wp)
    const a = this.aim as FlickAim & { capR: number }
    this.aim = { ...a, pointer: wp, ...f, spin: this.spinFor(f.dir, a.grab, a.capR, a.grabR) } as FlickAim
    this.hooks.onAim(this.aim)
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return
    const aim = this.aim
    const downAt = this.downAt
    const sp = this.local(e)
    this.aim = null
    this.pointerId = null
    this.downAt = null
    this.hooks.onAim(null)
    if (aim && aim.valid) {
      this.hooks.onFlick(aim.capId, aim.dir, aim.power, aim.spin)
    } else if (!aim && downAt && Math.hypot(sp.x - downAt.x, sp.y - downAt.y) < 12) {
      this.hooks.onTap?.()
    }
  }
}
