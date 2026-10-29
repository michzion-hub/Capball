import { PHYSICS } from '../config/tuning'

/**
 * Decides when a play is over: every body must be at rest continuously for `holdMs`.
 * Pure and time-driven so it is trivially testable.
 */
export class SettleDetector {
  private restMs = 0
  private elapsedMs = 0
  /** `holdMs` fixed for tests; omitted = read live from PHYSICS (tuning overlay can change it). */
  constructor(private readonly holdMs?: number) {}

  reset(): void {
    this.restMs = 0
    this.elapsedMs = 0
  }

  /** Feed one step. Returns true once the scene has been continuously at rest for holdMs. */
  update(atRest: boolean, dtMs: number): boolean {
    this.elapsedMs += dtMs
    this.restMs = atRest ? this.restMs + dtMs : 0
    return this.restMs >= (this.holdMs ?? PHYSICS.settleHoldMs)
  }

  get playMs(): number { return this.elapsedMs }
}
