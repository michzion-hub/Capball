import { INPUT } from '../config/tuning'
import type { Vec } from '../physics/world'
import type { View } from '../render/view'

interface KeeperTarget { x: number; y: number; radius: number }
interface KeeperDragHooks {
  target(): KeeperTarget | null
  onMove(position: Vec): void
}

let attachedPenaltyHandlers = 0
export function activePenaltyInputHandlers(): number { return attachedPenaltyHandlers }

/** Independent drag handler used only during the hidden keeper-choice phase. */
export class KeeperDragInput {
  private abort: AbortController | null = null
  private pointerId: number | null = null

  constructor(private readonly canvas: HTMLCanvasElement, private readonly view: View, private readonly hooks: KeeperDragHooks) {}

  attach(): void {
    if (this.abort) return
    this.abort = new AbortController()
    attachedPenaltyHandlers++
    const signal = this.abort.signal
    this.canvas.addEventListener('pointerdown', e => this.down(e), { signal })
    this.canvas.addEventListener('pointermove', e => this.move(e), { signal })
    this.canvas.addEventListener('pointerup', e => this.up(e), { signal })
    this.canvas.addEventListener('pointercancel', () => this.cancel(), { signal })
    this.canvas.addEventListener('lostpointercapture', () => this.cancel(), { signal })
  }

  cancel(): void {
    if (this.pointerId !== null) {
      try { this.canvas.releasePointerCapture(this.pointerId) } catch { /* capture already ended */ }
    }
    this.pointerId = null
  }

  detach(): void {
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    attachedPenaltyHandlers--
    this.cancel()
  }

  private local(e: PointerEvent): Vec {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private down(e: PointerEvent): void {
    if (this.pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return
    const target = this.hooks.target()
    if (!target) return
    const world = this.view.toWorld(this.local(e))
    const slop = (e.pointerType === 'touch' ? INPUT.touchPickSlopPx : INPUT.mousePickSlopPx) / this.view.scale
    if (Math.hypot(world.x - target.x, world.y - target.y) > target.radius + slop) return
    e.preventDefault()
    this.pointerId = e.pointerId
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* synthetic event */ }
    this.hooks.onMove(world)
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return
    e.preventDefault()
    this.hooks.onMove(this.view.toWorld(this.local(e)))
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return
    this.cancel()
  }
}

/**
 * In local play only, a second simultaneous touch during an aiming turn is an input foul.
 * The normal one-finger flick path is untouched. Direct cap translation is not a game input:
 * drags either produce the original flick or are cancelled by the existing minimum-drag rule.
 */
export class RuleGestureGuard {
  private abort: AbortController | null = null
  private readonly touches = new Set<number>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: View,
    private readonly active: () => boolean,
    private readonly onMultiTouch: (at: Vec) => void,
  ) {}

  attach(): void {
    if (this.abort) return
    this.abort = new AbortController()
    attachedPenaltyHandlers++
    const signal = this.abort.signal
    this.canvas.addEventListener('pointerdown', e => this.down(e), { signal, capture: true })
    this.canvas.addEventListener('pointerup', e => this.touches.delete(e.pointerId), { signal, capture: true })
    this.canvas.addEventListener('pointercancel', e => this.touches.delete(e.pointerId), { signal, capture: true })
    this.canvas.addEventListener('lostpointercapture', e => this.touches.delete(e.pointerId), { signal, capture: true })
  }

  detach(): void {
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    this.touches.clear()
    attachedPenaltyHandlers--
  }

  private down(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    if (this.active() && this.touches.size > 0) {
      const rect = this.canvas.getBoundingClientRect()
      e.preventDefault()
      e.stopImmediatePropagation()
      this.touches.add(e.pointerId)
      this.onMultiTouch(this.view.toWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }))
      this.touches.clear()
      return
    }
    this.touches.add(e.pointerId)
  }
}
