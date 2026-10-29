import { FX, PHYSICS } from '../config/tuning'
import type { PhysicsWorld } from '../physics/world'

/**
 * Ring buffer of body poses, recorded every `every` physics steps.
 * On a goal we cut a clip (lead-up + tail) and play it back in slow motion.
 * Fixed allocation: no per-frame garbage.
 */
export class ReplayRecorder {
  readonly stride: number
  readonly hz: number
  private readonly buf: Float32Array
  private readonly capacity: number
  private head = 0
  private count = 0
  private stepCounter = 0
  /** Total frames ever recorded (absolute index for marks). */
  private total = 0
  private readonly every: number

  constructor(private readonly world: PhysicsWorld, seconds: number = FX.replaySeconds + FX.replayTail + FX.celebrateMs / 1000 + 0.6, every = 2) {
    this.every = every
    this.hz = PHYSICS.stepHz / every
    this.stride = world.bodyCount * 3
    this.capacity = Math.ceil(seconds * this.hz)
    this.buf = new Float32Array(this.capacity * this.stride)
  }

  reset(): void { this.head = 0; this.count = 0; this.stepCounter = 0; this.total = 0 }

  /** Call after every fixed physics step. */
  record(): void {
    if (++this.stepCounter % this.every !== 0) return
    this.world.writeSnapshot(this.buf, this.head * this.stride)
    this.head = (this.head + 1) % this.capacity
    this.count = Math.min(this.count + 1, this.capacity)
    this.total++
  }

  get frames(): number { return this.count }

  /** Absolute frame index "now" — remember it at the goal. */
  mark(): number { return this.total }

  /** Clip from `lead` seconds before the mark to `tail` seconds after it (clamped to what is buffered). */
  clipAround(mark: number, lead: number, tail: number): ReplayClip {
    const endAbs = Math.min(this.total, mark + Math.ceil(tail * this.hz))
    const oldestAbs = this.total - this.count
    const startAbs = Math.max(oldestAbs, mark - Math.ceil(lead * this.hz))
    const n = Math.max(0, endAbs - startAbs)
    const out = new Float32Array(n * this.stride)
    for (let i = 0; i < n; i++) {
      const back = this.total - (startAbs + i) // 1 = newest
      const src = ((this.head - back) % this.capacity + this.capacity) % this.capacity
      out.set(this.buf.subarray(src * this.stride, src * this.stride + this.stride), i * this.stride)
    }
    return new ReplayClip(out, n, this.stride, this.hz)
  }

  /** Copy out the last `seconds` as a standalone clip. */
  clip(seconds: number): ReplayClip {
    const n = Math.min(this.count, Math.ceil(seconds * this.hz))
    const out = new Float32Array(n * this.stride)
    for (let i = 0; i < n; i++) {
      const src = ((this.head - n + i) % this.capacity + this.capacity) % this.capacity
      out.set(this.buf.subarray(src * this.stride, src * this.stride + this.stride), i * this.stride)
    }
    return new ReplayClip(out, n, this.stride, this.hz)
  }
}

export class ReplayClip {
  constructor(readonly data: Float32Array, readonly frames: number, readonly stride: number, readonly hz: number) {}

  get duration(): number { return this.frames / this.hz }

  /** Interpolated pose of body `i` at time t (s). */
  pose(t: number, i: number): { x: number; y: number; angle: number } {
    const f = Math.max(0, Math.min(this.frames - 1, t * this.hz))
    const a = Math.floor(f)
    const b = Math.min(this.frames - 1, a + 1)
    const k = f - a
    const oa = a * this.stride + i * 3
    const ob = b * this.stride + i * 3
    const d = this.data
    return { x: d[oa] + (d[ob] - d[oa]) * k, y: d[oa + 1] + (d[ob + 1] - d[oa + 1]) * k, angle: d[oa + 2] + (d[ob + 2] - d[oa + 2]) * k }
  }
}
