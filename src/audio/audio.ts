/**
 * All sound is synthesised with WebAudio — no audio files, works offline.
 * Created lazily on the first user gesture (browser autoplay rules).
 */
export type ImpactKind = 'cap' | 'ball' | 'board' | 'post' | 'net'

export class Audio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private lastImpact = 0
  enabled = true

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.enabled ? 0.9 : 0
      this.master.connect(this.ctx.destination)
      const len = this.ctx.sampleRate * 2
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      this.onReady?.()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  onReady?: () => void

  get context(): AudioContext | null { return this.ctx }
  get out(): GainNode | null { return this.master }
  get noiseBuffer(): AudioBuffer | null { return this.noise }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.03)
  }

  private live(): AudioContext | null {
    return this.enabled && this.ctx && this.ctx.state === 'running' ? this.ctx : null
  }

  /** Collision sound; `impact` is closing speed (wu/tick). Volume, pitch and brightness follow force. */
  impact(kind: ImpactKind, impact: number): void {
    const ctx = this.live()
    if (!ctx || !this.master || impact < 0.6) return
    const now = ctx.currentTime
    if (now - this.lastImpact < 0.012) return // de-dupe multi-contact bursts
    this.lastImpact = now
    const f = Math.min(1, impact / 22)
    const vol = 0.05 + f * 0.55
    const g = ctx.createGain()
    g.connect(this.master)
    if (kind === 'cap' || kind === 'ball') {
      // plastic/rubber "tock": short pitched click + noise transient
      const o = ctx.createOscillator()
      o.type = kind === 'cap' ? 'triangle' : 'sine'
      const base = kind === 'cap' ? 1250 + Math.random() * 300 : 420 + Math.random() * 60
      o.frequency.setValueAtTime(base * (0.8 + f * 0.6), now)
      o.frequency.exponentialRampToValueAtTime(base * 0.45, now + 0.06)
      g.gain.setValueAtTime(vol, now)
      g.gain.exponentialRampToValueAtTime(0.0008, now + (kind === 'cap' ? 0.07 : 0.12))
      o.connect(g)
      o.start(now)
      o.stop(now + 0.15)
      this.noiseHit(now, vol * 0.6, kind === 'cap' ? 3500 : 1400, 0.025)
    } else if (kind === 'post') {
      for (const [fr, a] of [[880, 1], [1320, 0.5], [2210, 0.3]] as const) {
        const o = ctx.createOscillator()
        const og = ctx.createGain()
        o.frequency.value = fr * (0.98 + Math.random() * 0.04)
        og.gain.setValueAtTime(vol * a * 0.7, now)
        og.gain.exponentialRampToValueAtTime(0.0005, now + 0.7)
        o.connect(og).connect(this.master)
        o.start(now)
        o.stop(now + 0.75)
      }
      g.disconnect()
    } else {
      // board = hollow wooden bonk; net = soft swish
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(kind === 'board' ? 150 + f * 70 : 90, now)
      o.frequency.exponentialRampToValueAtTime(70, now + 0.12)
      g.gain.setValueAtTime(kind === 'board' ? vol : vol * 0.3, now)
      g.gain.exponentialRampToValueAtTime(0.0008, now + 0.16)
      o.connect(g)
      o.start(now)
      o.stop(now + 0.2)
      this.noiseHit(now, vol * (kind === 'net' ? 0.6 : 0.35), kind === 'net' ? 900 : 600, kind === 'net' ? 0.18 : 0.05)
    }
  }

  private noiseHit(at: number, vol: number, freq: number, dur: number): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    bp.Q.value = 1.2
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, at)
    g.gain.exponentialRampToValueAtTime(0.0005, at + dur)
    src.connect(bp).connect(g).connect(this.master!)
    src.start(at, Math.random())
    src.stop(at + dur + 0.02)
  }

  flick(power: number): void {
    const ctx = this.live()
    if (!ctx) return
    this.noiseHit(ctx.currentTime, 0.1 + power * 0.3, 2400 + power * 2000, 0.05)
  }

  whistle(long = false): void {
    const ctx = this.live()
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    const blasts = long ? [[0, 0.22], [0.3, 0.22], [0.6, 0.7]] : [[0, 0.32]]
    for (const [t, d] of blasts) {
      const o = ctx.createOscillator()
      const lfo = ctx.createOscillator()
      const lg = ctx.createGain()
      const g = ctx.createGain()
      o.frequency.value = 2650
      lfo.frequency.value = 38
      lg.gain.value = 120
      lfo.connect(lg).connect(o.frequency)
      g.gain.setValueAtTime(0, now + t)
      g.gain.linearRampToValueAtTime(0.16, now + t + 0.02)
      g.gain.setValueAtTime(0.16, now + t + d - 0.04)
      g.gain.linearRampToValueAtTime(0, now + t + d)
      o.connect(g).connect(this.master)
      o.start(now + t); lfo.start(now + t)
      o.stop(now + t + d + 0.05); lfo.stop(now + t + d + 0.05)
    }
  }

  /** Air horn for goals. */
  horn(): void {
    const ctx = this.live()
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    for (const fr of [233, 293, 349]) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sawtooth'
      o.frequency.value = fr
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.07, now + 0.04)
      g.gain.setValueAtTime(0.07, now + 0.9)
      g.gain.linearRampToValueAtTime(0, now + 1.2)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 1800
      o.connect(lp).connect(g).connect(this.master)
      o.start(now)
      o.stop(now + 1.25)
    }
  }

  ui(): void {
    const ctx = this.live()
    if (!ctx) return
    this.noiseHit(ctx.currentTime, 0.12, 5200, 0.02)
  }
}
