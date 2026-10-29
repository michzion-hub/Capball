import { PITCH } from '../config/tuning'
import type { TeamIndex, Vec } from '../physics/world'

/** Team-0 (left) base formation by slot: keeper, defender, defender, winger, striker. */
const BASE: Vec[] = [
  { x: 62, y: 310 },
  { x: 205, y: 200 },
  { x: 205, y: 420 },
  { x: 315, y: 112 },
  { x: 380, y: 352 },
]
const KICKOFF_STRIKER: Vec = { x: 452, y: 310 }

export function mirror(p: Vec): Vec {
  return { x: PITCH.width - p.x, y: PITCH.height - p.y }
}

export function kickoffPosition(team: TeamIndex, slot: number, kickingTeam: TeamIndex): Vec {
  const p = slot === 4 && team === kickingTeam ? KICKOFF_STRIKER : BASE[slot]
  return team === 0 ? { ...p } : mirror(p)
}

/** Original (non-kickoff) formation spot for a cap — used for goal-kick resets. */
export function basePosition(team: TeamIndex, slot: number): Vec {
  const p = BASE[slot]
  return team === 0 ? { ...p } : mirror(p)
}
export const CENTER: Vec = { x: PITCH.width / 2, y: PITCH.height / 2 }

export interface Circle { x: number; y: number; r: number }

/** Clamp a point inside the playing area with a margin. */
export function clampToPitch(p: Vec, margin: number): Vec {
  return {
    x: Math.min(PITCH.width - margin, Math.max(margin, p.x)),
    y: Math.min(PITCH.height - margin, Math.max(margin, p.y)),
  }
}

/**
 * Nearest point to `target` where a circle of radius r does not overlap any obstacle.
 * Spiral search; deterministic. Used only for between-play placement (set pieces).
 */
export function findFreeSpot(target: Vec, r: number, obstacles: Circle[], margin = 4): Vec {
  const ok = (p: Vec) => obstacles.every(o => Math.hypot(o.x - p.x, o.y - p.y) >= o.r + r + margin)
  const start = clampToPitch(target, r + 2)
  if (ok(start)) return start
  for (let ring = 1; ring < 60; ring++) {
    const rad = ring * 6
    const n = 8 + ring * 2
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const p = clampToPitch({ x: start.x + Math.cos(a) * rad, y: start.y + Math.sin(a) * rad }, r + 2)
      if (ok(p)) return p
    }
  }
  return start
}
