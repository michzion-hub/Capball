import { BALL, DEADBALL, PITCH } from '../config/tuning'
import type { Vec } from '../physics/world'
import { CENTER, clampToPitch } from './formation'

export interface CapCircle { x: number; y: number; r: number }

const goalTop = (PITCH.height - PITCH.goalWidth) / 2
const goalBottom = (PITCH.height + PITCH.goalWidth) / 2

/** Which boards/posts the ball is resting against (0, 1 or 2 = wedged in a corner). */
export function edgesTouching(ball: Vec): number {
  const reach = BALL.radius + DEADBALL.edgeMargin
  let n = 0
  if (ball.y < reach || ball.y > PITCH.height - reach) n++
  const inMouth = ball.y > goalTop && ball.y < goalBottom
  if (!inMouth && (ball.x < reach || ball.x > PITCH.width - reach)) n++
  // Posts are boards too.
  for (const px of [0, PITCH.width]) for (const py of [goalTop, goalBottom]) {
    if (Math.hypot(ball.x - px, ball.y - py) < reach + PITCH.postRadius) n++
  }
  return n
}

/**
 * Pinned = the ball is against the boards AND either wedged in a corner or squeezed by a cap.
 * A free ball lying along the boards is not pinned: you can still slide a cap into it.
 */
export function isPinned(ball: Vec, caps: CapCircle[]): boolean {
  const edges = edgesTouching(ball)
  if (edges === 0) return false
  if (edges >= 2) return true
  return caps.some(c => Math.hypot(c.x - ball.x, c.y - ball.y) <= c.r + BALL.radius + DEADBALL.pinGap)
}

/** Counts consecutive plays in which a pinned ball never moved. Pure; the match feeds it once per settled play. */
export class DeadBallWatch {
  count = 0
  constructor(private readonly limit: number) {}

  /** Returns true when the ref should drop the ball (and resets). */
  afterPlay(ballBefore: Vec, ballAfter: Vec, caps: CapCircle[]): boolean {
    if (this.limit <= 0) return false
    const moved = Math.hypot(ballAfter.x - ballBefore.x, ballAfter.y - ballBefore.y) > DEADBALL.moveEps
    if (moved || !isPinned(ballAfter, caps)) { this.count = 0; return false }
    this.count++
    if (this.count < this.limit) return false
    this.count = 0
    return true
  }

  reset(): void { this.count = 0 }
}

/** Drop spot: a short way from the ball toward the centre spot, well clear of the boards. */
export function dropSpot(ball: Vec): Vec {
  const dx = CENTER.x - ball.x
  const dy = CENTER.y - ball.y
  const d = Math.hypot(dx, dy) || 1
  const k = Math.min(DEADBALL.dropDistance, d) / d
  return clampToPitch({ x: ball.x + dx * k, y: ball.y + dy * k }, BALL.radius + 40)
}
