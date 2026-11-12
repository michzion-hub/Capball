/**
 * Cheap, privacy-safe online diagnostics.
 *
 * Everything here is local measurement (round-trip time from our own ping, snapshot
 * ordering, correction size). No player input, crew design or penalty choice is kept.
 * Values are bounded and rounded before they are shown, so a hostile or glitching
 * server cannot put a 10-foot number in the pause sheet.
 */

export interface OnlineDiagnosticsView {
  rttMs: number | null
  jitterMs: number | null
  seq: number
  gaps: number
  stale: number
  corrections: number
  lastCorrectionPx: number
  maxCorrectionPx: number
  reconnects: number
  link: string
}

export type SnapshotOrder = 'ok' | 'gap' | 'stale'

const MAX_RTT_MS = 5000
const MAX_CORRECTION_PX = 2000
const round1 = (n: number): number => Math.round(n * 10) / 10

export class OnlineDiagnostics {
  private rtt: number | null = null
  private jitter: number | null = null
  private previousRtt: number | null = null
  private lastSeq = -1
  private gaps = 0
  private stale = 0
  private corrections = 0
  private lastCorrection = 0
  private maxCorrection = 0
  private reconnects = 0
  private link = 'idle'

  /** Feed one measured ping round-trip. Exponentially smoothed, with jitter as mean absolute change. */
  rttSample(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const sample = Math.min(MAX_RTT_MS, ms)
    this.rtt = this.rtt === null ? sample : this.rtt * 0.75 + sample * 0.25
    if (this.previousRtt !== null) {
      const delta = Math.abs(sample - this.previousRtt)
      this.jitter = this.jitter === null ? delta : this.jitter * 0.75 + delta * 0.25
    }
    this.previousRtt = sample
  }

  /** Count a state snapshot and report whether it advanced normally, left a gap, or arrived stale. */
  snapshot(seq: number): SnapshotOrder {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      this.stale++
      return 'stale'
    }
    if (seq <= this.lastSeq) {
      this.stale++
      return 'stale'
    }
    const gap = this.lastSeq >= 0 && seq > this.lastSeq + 1
    if (gap) this.gaps += seq - this.lastSeq - 1
    this.lastSeq = seq
    return gap ? 'gap' : 'ok'
  }

  /** Record the size of one authoritative correction (0 for no correction). */
  correction(px: number): void {
    if (!Number.isFinite(px) || px < 0) return
    const size = Math.min(MAX_CORRECTION_PX, px)
    this.corrections++
    this.lastCorrection = size
    if (size > this.maxCorrection) this.maxCorrection = size
  }

  reconnect(): void { this.reconnects++ }

  setLink(link: string): void { this.link = link.slice(0, 24) }

  /** Forget per-room measurements. Reconnect count is deliberately session-wide. */
  reset(): void {
    this.rtt = null
    this.jitter = null
    this.previousRtt = null
    this.lastSeq = -1
    this.gaps = 0
    this.stale = 0
    this.corrections = 0
    this.lastCorrection = 0
    this.maxCorrection = 0
    this.link = 'idle'
  }

  read(): OnlineDiagnosticsView {
    return {
      rttMs: this.rtt === null ? null : round1(this.rtt),
      jitterMs: this.jitter === null ? null : round1(this.jitter),
      seq: this.lastSeq,
      gaps: this.gaps,
      stale: this.stale,
      corrections: this.corrections,
      lastCorrectionPx: round1(this.lastCorrection),
      maxCorrectionPx: round1(this.maxCorrection),
      reconnects: this.reconnects,
      link: this.link,
    }
  }
}
