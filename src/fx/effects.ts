import { FX } from '../config/tuning'

interface P {
  x: number; y: number; vx: number; vy: number
  life: number; max: number; size: number; grow: number
  color: string; kind: 0 | 1 | 2 // 0 dust puff, 1 confetti, 2 spark/fire
  rot: number; vr: number
}

/** Fixed-size particle pool (no allocation after construction). */
export class Particles {
  private pool: P[]
  private alive = 0

  constructor(private readonly max = 520) {
    this.pool = Array.from({ length: max }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, grow: 0, color: '#fff', kind: 0, rot: 0, vr: 0 }))
  }

  get count(): number { return this.alive }

  private spawn(): P | null {
    if (this.alive >= this.max) return null
    return this.pool[this.alive++]
  }

  dust(x: number, y: number, n: number, color: string, speed = 0.6, size = 5): void {
    for (let i = 0; i < n; i++) {
      const p = this.spawn()
      if (!p) return
      const a = Math.random() * Math.PI * 2
      const s = speed * (0.3 + Math.random())
      Object.assign(p, { x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.5 + Math.random() * 0.6, size: size * (0.6 + Math.random() * 0.6), grow: size * 1.6, color, kind: 0, rot: 0, vr: 0 })
    }
  }

  confetti(x: number, y: number, dirX: number, n: number, colors: string[]): void {
    for (let i = 0; i < n; i++) {
      const p = this.spawn()
      if (!p) return
      const a = Math.atan2(0, dirX) + (Math.random() - 0.5) * 2.4
      const s = 3 + Math.random() * 7
      Object.assign(p, { x, y: y + (Math.random() - 0.5) * 120, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 1.4 + Math.random() * 1.2, size: 4 + Math.random() * 5, grow: 0, color: colors[i % colors.length], kind: 1, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 })
    }
  }

  fire(x: number, y: number, vx: number, vy: number): void {
    const p = this.spawn()
    if (!p) return
    const c = Math.random() < 0.5 ? '#ffb020' : '#ff4b1f'
    Object.assign(p, { x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10, vx: -vx * 0.08 + (Math.random() - 0.5), vy: -vy * 0.08 + (Math.random() - 0.5), life: 0, max: 0.35 + Math.random() * 0.25, size: 7 + Math.random() * 5, grow: -8, color: c, kind: 2, rot: 0, vr: 0 })
  }

  update(dt: number): void {
    const k = dt * 60
    for (let i = 0; i < this.alive; i++) {
      const p = this.pool[i]
      p.life += dt
      if (p.life >= p.max) {
        // swap-remove
        this.alive--
        const last = this.pool[this.alive]
        this.pool[this.alive] = p
        this.pool[i] = last
        i--
        continue
      }
      p.x += p.vx * k
      p.y += p.vy * k
      const drag = p.kind === 1 ? 0.94 : 0.9
      p.vx *= Math.pow(drag, k)
      p.vy *= Math.pow(drag, k)
      p.rot += p.vr * dt
      p.size = Math.max(0.5, p.size + p.grow * dt)
    }
  }

  draw(ctx: CanvasRenderingContext2D, kinds: (0 | 1 | 2)[]): void {
    for (let i = 0; i < this.alive; i++) {
      const p = this.pool[i]
      if (!kinds.includes(p.kind)) continue
      const t = p.life / p.max
      if (p.kind === 0) {
        ctx.globalAlpha = 0.45 * (1 - t)
        ctx.fillStyle = p.color
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill()
      } else if (p.kind === 1) {
        ctx.globalAlpha = 1 - t * t
        ctx.fillStyle = p.color
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore()
      } else {
        ctx.globalAlpha = 0.85 * (1 - t)
        ctx.fillStyle = p.color
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  clear(): void { this.alive = 0 }
}

/** Trauma-style screen shake in CSS px. */
export class Shake {
  private trauma = 0
  x = 0
  y = 0
  add(amount: number): void { this.trauma = Math.min(FX.shakeMax, this.trauma + amount) }
  update(dt: number, enabled = true): void {
    this.trauma = Math.max(0, this.trauma - FX.shakeDecay * dt * (1 + this.trauma * 0.25))
    if (!enabled || this.trauma <= 0.01) { this.x = 0; this.y = 0; return }
    this.x = (Math.random() * 2 - 1) * this.trauma
    this.y = (Math.random() * 2 - 1) * this.trauma
  }
  clear(): void { this.trauma = 0; this.x = 0; this.y = 0 }
}
