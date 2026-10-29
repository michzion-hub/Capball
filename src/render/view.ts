import { PITCH } from '../config/tuning'
import type { Vec } from '../physics/world'

/**
 * Maps world units ↔ CSS pixels. Fits the pitch (plus margin) into the canvas and rotates it
 * 90° on portrait screens so caps stay large enough to touch on phones.
 */
export class View {
  scale = 1
  rotated = false
  cssW = 1
  cssH = 1
  dpr = 1
  /** Reserved CSS px at the top for the scoreboard. */
  topInset = 0
  bottomInset = 0
  private cx = 0
  private cy = 0

  /**
   * `extra` reserves room for a docked panel (tuning overlay). It shrinks the fit area but never
   * changes the rotation decision, so opening the panel can't flip the pitch mid-match.
   */
  resize(cssW: number, cssH: number, dpr: number, topInset: number, bottomInset: number, extra: { right: number; bottom: number } = { right: 0, bottom: 0 }): void {
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    this.topInset = topInset
    this.bottomInset = bottomInset
    const m = PITCH.viewMargin
    const ww = PITCH.width + 2 * m
    const wh = PITCH.height + 2 * m
    this.rotated = Math.max(50, cssH - topInset - bottomInset) > cssW * 1.05
    const availW = Math.max(50, cssW - extra.right)
    const availH = Math.max(50, cssH - topInset - Math.max(bottomInset, extra.bottom))
    const fitW = this.rotated ? wh : ww
    const fitH = this.rotated ? ww : wh
    this.scale = Math.min(availW / fitW, availH / fitH)
    this.cx = availW / 2
    this.cy = topInset + availH / 2
  }

  /** world → css px */
  toScreen(p: Vec): Vec {
    const dx = (p.x - PITCH.width / 2) * this.scale
    const dy = (p.y - PITCH.height / 2) * this.scale
    // Portrait: rotate so team 0's goal is at the bottom (left goal → bottom).
    return this.rotated ? { x: this.cx + dy, y: this.cy - dx } : { x: this.cx + dx, y: this.cy + dy }
  }

  /** css px → world */
  toWorld(p: Vec): Vec {
    const sx = p.x - this.cx
    const sy = p.y - this.cy
    const dx = this.rotated ? -sy : sx
    const dy = this.rotated ? sx : sy
    return { x: dx / this.scale + PITCH.width / 2, y: dy / this.scale + PITCH.height / 2 }
  }

  /** Apply the world transform to a 2D context (after DPR scaling). */
  apply(ctx: CanvasRenderingContext2D, shakeX = 0, shakeY = 0): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.translate(this.cx + shakeX, this.cy + shakeY)
    if (this.rotated) ctx.rotate(-Math.PI / 2)
    ctx.scale(this.scale, this.scale)
    ctx.translate(-PITCH.width / 2, -PITCH.height / 2)
  }
}
