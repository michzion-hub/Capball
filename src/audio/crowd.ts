import type { Audio } from './audio'

/**
 * A street crowd built from filtered noise: a low murmur bed that breathes, plus
 * swells (goals), "oohs" (near misses) and a clap-chant. All synthesised, so it works offline.
 */
export class Crowd {
  private bed: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null
  private excitement = 0

  constructor(private readonly audio: Audio) {}

  /** Start the murmur (idempotent). Needs an unlocked context. */
  start(): void {
    const ctx = this.audio.context
    const out = this.audio.out
    const noise = this.audio.noiseBuffer
    if (!ctx || !out || !noise || this.bed) return
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 520
    bp.Q.value = 0.7
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1400
    const gain = ctx.createGain()
    gain.gain.value = 0.035
    // Slow "breathing" so it never sounds like a static hiss.
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.frequency.value = 0.13
    lfoGain.gain.value = 0.012
    lfo.connect(lfoGain).connect(gain.gain)
    src.connect(bp).connect(lp).connect(gain).connect(out)
    src.start()
    lfo.start()
    this.bed = { src, gain, lfo }
  }

  stop(): void {
    if (!this.bed) return
    try { this.bed.src.stop(); this.bed.lfo.stop() } catch { /* already stopped */ }
    this.bed.src.disconnect()
    this.bed.gain.disconnect()
    this.bed = null
  }

  /** Raise the bed level for a moment (0..1). */
  swell(level: number, seconds = 2.5): void {
    const ctx = this.audio.context
    if (!ctx || !this.bed || !this.audio.enabled) return
    const now = ctx.currentTime
    const g = this.bed.gain.gain
    const peak = 0.035 + level * 0.22
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(peak, now + 0.25)
    g.setTargetAtTime(0.035 + this.excitement * 0.03, now + seconds * 0.5, seconds * 0.4)
    if (level > 0.6) this.roar(level, seconds)
  }

  /** Tension builds when the ball is near a goal. 0..1. */
  setExcitement(x: number): void {
    this.excitement = Math.max(0, Math.min(1, x))
    const ctx = this.audio.context
    if (!ctx || !this.bed) return
    this.bed.gain.gain.setTargetAtTime(0.035 + this.excitement * 0.03, ctx.currentTime, 0.8)
  }

  private roar(level: number, seconds: number): void {
    const ctx = this.audio.context!
    const out = this.audio.out!
    const now = ctx.currentTime
    // A bank of detuned "voices": noise through formant-ish bandpasses.
    for (const f of [380, 720, 1150]) {
      const src = ctx.createBufferSource()
      src.buffer = this.audio.noiseBuffer
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f
      bp.Q.value = 2.5
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.09 * level, now + 0.18)
      g.gain.setTargetAtTime(0, now + seconds * 0.45, seconds * 0.3)
      src.connect(bp).connect(g).connect(out)
      src.start(now, Math.random())
      src.stop(now + seconds + 1.5)
    }
  }

  /** Near miss: a falling "ooooh". */
  ooh(): void {
    const ctx = this.audio.context
    const out = this.audio.out
    if (!ctx || !out || !this.audio.enabled) return
    const now = ctx.currentTime
    for (const [f, q] of [[450, 6], [820, 5]] as const) {
      const src = ctx.createBufferSource()
      src.buffer = this.audio.noiseBuffer
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = q
      bp.frequency.setValueAtTime(f * 1.25, now)
      bp.frequency.exponentialRampToValueAtTime(f * 0.7, now + 1.1)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.16, now + 0.15)
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.3)
      src.connect(bp).connect(g).connect(out)
      src.start(now, Math.random())
      src.stop(now + 1.4)
    }
  }

  /** Rhythmic claps (clap-clap-clapclapclap). */
  chant(): void {
    const ctx = this.audio.context
    const out = this.audio.out
    if (!ctx || !out || !this.audio.enabled) return
    const now = ctx.currentTime
    const beats = [0, 0.32, 0.64, 0.8, 0.96]
    for (const rep of [0, 1.4]) for (const b of beats) {
      const t = now + rep + b
      const src = ctx.createBufferSource()
      src.buffer = this.audio.noiseBuffer
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 1600
      bp.Q.value = 0.9
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.13, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
      src.connect(bp).connect(g).connect(out)
      src.start(t, Math.random())
      src.stop(t + 0.1)
    }
  }
}
