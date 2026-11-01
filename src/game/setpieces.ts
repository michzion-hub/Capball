import { CAP_TYPES, BALL, DEADBALL, PITCH } from '../config/tuning'
import { FOOTBALL } from '../config/football'
import type { CapTypeId } from '../config/tuning'
import type { Ruleset } from '../config/rulesets'
import type { TeamIndex, Vec } from '../physics/world'
import { basePosition, clampToPitch, findFreeSpot } from './formation'
import type { Circle } from './formation'
import type { Outcome } from './play'
import { attackDir } from './rules'

export interface PieceCap { id: number; team: TeamIndex; slot: number; type: CapTypeId; x: number; y: number; active: boolean }

const H = PITCH.height
const W = PITCH.width
const rOf = (c: PieceCap) => CAP_TYPES[c.type].radius

/**
 * Where everything should slide to before a set piece. Returns targets for every cap (same order)
 * and the ball. Pure; positions only ever change between plays.
 */
export function setPieceTargets(o: Outcome, caps: PieceCap[], _ball: Vec, rules: Ruleset): { caps: Vec[]; ball: Vec } | null {
  if (o.kind === 'normal' || o.kind === 'bonus') return keeperBoxTargets(caps, _ball, rules)
  const kicker = o.next
  const targets: Vec[] = caps.map(c => ({ x: c.x, y: c.y }))
  let ballAt: Vec
  const r = rOf

  if (o.kind === 'penalty') {
    const lineX = o.end === 0 ? 0 : W
    const inward = o.end === 0 ? 1 : -1
    ballAt = { x: lineX + inward * PITCH.penaltySpot, y: H / 2 }
    const defenders = o.end === 0 ? 0 : 1
    const boxDepth = PITCH.penaltyBox.depth
    const placed: Circle[] = [{ x: ballAt.x, y: ballAt.y, r: BALL.radius }]
    const keeper = caps.find(c => c.team === defenders && c.slot === 0 && c.active)
    const taker = caps.find(c => c.team === kicker && c.slot === 4 && c.active) ?? caps.find(c => c.team === kicker && c.active)
    if (keeper) {
      targets[keeper.id] = { x: lineX + inward * (r(keeper) + FOOTBALL.keeperLineInset), y: H / 2 }
      placed.push({ ...targets[keeper.id], r: r(keeper) })
    }
    if (taker) {
      targets[taker.id] = { x: ballAt.x + inward * (BALL.radius + r(taker) + FOOTBALL.penaltyTakerGap), y: H / 2 }
      placed.push({ ...targets[taker.id], r: r(taker) })
    }
    // Every other cap starts beyond the box line and on the midfield side of the ball.
    const others = caps.filter(c => c.active && c !== keeper && c !== taker)
    others.forEach((c, index) => {
      const x = lineX + inward * (boxDepth + r(c) + FOOTBALL.penaltyRetreatInset)
      const y = H * (index + 1) / (others.length + 1)
      const p = findFreeSpot({ x, y }, r(c), placed, FOOTBALL.restartInset / 4)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    })
    return { caps: targets, ball: ballAt }
  }

  if (o.kind === 'dropball') {
    ballAt = o.at
    const clear = DEADBALL.clearRadius
    const placed: Circle[] = [{ x: ballAt.x, y: ballAt.y, r: clear }]
    for (const c of caps) {
      if (!c.active) continue
      const d = Math.hypot(c.x - ballAt.x, c.y - ballAt.y)
      let p = { x: c.x, y: c.y }
      if (d < clear + r(c)) {
        const ux = d > 1e-3 ? (c.x - ballAt.x) / d : attackDir(c.team) * -1
        const uy = d > 1e-3 ? (c.y - ballAt.y) / d : 0
        p = { x: ballAt.x + ux * (clear + r(c) + 2), y: ballAt.y + uy * (clear + r(c) + 2) }
      }
      p = findFreeSpot(p, r(c), placed, 4)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    return { caps: targets, ball: ballAt }
  }

  if (o.kind === 'corner') return cornerSetup(o.end, o.at.y < H / 2 ? -1 : 1, kicker, caps, rules)

  if (o.kind === 'throwin') {
    ballAt = clampToPitch(o.at, BALL.radius + FOOTBALL.restartInset / 2)
    const placed: Circle[] = [{ ...ballAt, r: BALL.radius }]
    const taker = caps.find(c => c.team === kicker && c.slot === 3 && c.active)
      ?? caps.find(c => c.team === kicker && c.slot === 4 && c.active)
      ?? caps.find(c => c.team === kicker && c.active)
    const side = ballAt.y < H / 2 ? 1 : -1
    if (taker) {
      const p = clampToPitch({ x: ballAt.x, y: ballAt.y + side * (BALL.radius + r(taker) + FOOTBALL.throwInTakerGap) }, r(taker) + 4)
      targets[taker.id] = findFreeSpot(p, r(taker), placed, 3)
      placed.push({ ...targets[taker.id], r: r(taker) })
    }
    // Nearby teammates keep their shape, but cannot start on the ball or the thrower's cap.
    for (const c of caps) {
      if (!c.active || c.team !== kicker || c === taker) continue
      const p = findFreeSpot({ x: c.x, y: c.y }, r(c), placed, 3)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    // The opposing team must retreat the same set-piece distance.
    const wall: Circle = { ...ballAt, r: rules.wallDistance }
    for (const c of caps) {
      if (!c.active || c.team === kicker) continue
      const d = Math.hypot(c.x - ballAt.x, c.y - ballAt.y)
      let p = { x: c.x, y: c.y }
      if (d < rules.wallDistance + r(c)) {
        const ux = d > 1e-3 ? (c.x - ballAt.x) / d : -side
        const uy = d > 1e-3 ? (c.y - ballAt.y) / d : 0
        p = { x: ballAt.x + ux * (rules.wallDistance + r(c) + 2), y: ballAt.y + uy * (rules.wallDistance + r(c) + 2) }
      }
      p = findFreeSpot(p, r(c), [...placed, wall], 4)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    return { caps: targets, ball: ballAt }
  }

  if (o.kind === 'freekick') ballAt = clampToPitch(o.at, BALL.radius + FOOTBALL.restartInset / 2)
  else {
    // Goal kick: restart inside the six-yard goal area and reset the shape.
    const x = o.end === 0 ? PITCH.goalBox.depth : W - PITCH.goalBox.depth
    const y = o.at.y < H / 2 ? H / 2 - PITCH.goalBox.width / 4 : H / 2 + PITCH.goalBox.width / 4
    ballAt = { x, y }
    const placed: Circle[] = []
    for (const c of caps) {
      if (!c.active) continue
      let p = basePosition(c.team, c.slot)
      if (rules.goalKickRestriction && c.team !== kicker) {
        // Opponents line up just outside the penalty-area boundary, not inside the box.
        const edge = o.end === 0 ? PITCH.penaltyBox.depth : W - PITCH.penaltyBox.depth
        p = { x: edge + (o.end === 0 ? 1 : -1) * (r(c) + FOOTBALL.penaltyRetreatInset), y: H * (placed.length + 1) / (caps.length + 1) }
      }
      p = findFreeSpot(p, r(c), placed, 4)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    ballAt = findFreeSpot(ballAt, BALL.radius, placed, 3)
    return { caps: targets, ball: ballAt }
  }

  // Ball must not overlap any cap. Defenders retreat to the configured distance.
  ballAt = findFreeSpot(ballAt, BALL.radius, caps.filter(c => c.active).map(c => ({ x: c.x, y: c.y, r: r(c) })), 3)
  const wall = rules.wallDistance
  const placed: Circle[] = [{ x: ballAt.x, y: ballAt.y, r: BALL.radius }]
  for (const c of caps) if (c.active && c.team === kicker) placed.push({ x: c.x, y: c.y, r: r(c) })
  const dirKick = attackDir(kicker)
  for (const c of caps) {
    if (!c.active || c.team === kicker) continue
    const d = Math.hypot(c.x - ballAt.x, c.y - ballAt.y)
    let p = { x: c.x, y: c.y }
    if (d < wall + r(c)) {
      const ux = d > 1e-3 ? (c.x - ballAt.x) / d : dirKick
      const uy = d > 1e-3 ? (c.y - ballAt.y) / d : 0
      p = { x: ballAt.x + ux * (wall + r(c) + 2), y: ballAt.y + uy * (wall + r(c) + 2) }
    }
    p = findFreeSpot(p, r(c), [...placed, { x: ballAt.x, y: ballAt.y, r: wall }], 4)
    targets[c.id] = p
    placed.push({ ...p, r: r(c) })
  }
  return { caps: targets, ball: ballAt }
}

/** Correct a goalkeeper that has been pushed outside its own penalty area, only after play settles. */
function keeperBoxTargets(caps: PieceCap[], ball: Vec, rules: Ruleset): { caps: Vec[]; ball: Vec } | null {
  if (!rules.keeperBox) return null
  const targets: Vec[] = caps.map(c => ({ x: c.x, y: c.y }))
  let changed = false
  for (const c of caps) {
    if (!c.active || c.slot !== 0 || inOwnPenaltyArea(c)) continue
    const end = c.team as 0 | 1
    const inward = end === 0 ? 1 : -1
    const edgeX = end === 0 ? PITCH.penaltyBox.depth : W - PITCH.penaltyBox.depth
    const half = PITCH.penaltyBox.width / 2
    const y = Math.min(H / 2 + half - rOf(c) - FOOTBALL.keeperBoxInset, Math.max(H / 2 - half + rOf(c) + FOOTBALL.keeperBoxInset, c.y))
    const p = { x: edgeX - inward * (rOf(c) + FOOTBALL.penaltyRetreatInset), y }
    targets[c.id] = p
    changed = true
  }
  return changed ? { caps: targets, ball: { ...ball } } : null
}

function inOwnPenaltyArea(c: PieceCap): boolean {
  const end = c.team as 0 | 1
  const half = PITCH.penaltyBox.width / 2
  const inY = c.y >= H / 2 - half && c.y <= H / 2 + half
  return inY && (end === 0 ? c.x <= PITCH.penaltyBox.depth : c.x >= W - PITCH.penaltyBox.depth)
}

/**
 * Corner shape, as (depth from the goal line, offset from the centre line toward the corner side).
 * Slots: 0 keeper, 1–2 defenders, 3 winger, 4 striker. `s` = +1 bottom corner, -1 top corner.
 */
const CORNER_ATTACK: Record<number, [number, number]> = {
  4: [112, -30], 2: [58, 70], 1: [190, 15],
}
const CORNER_DEFEND: Record<number, [number, number]> = {
  0: [0, 18], 1: [34, 98], 2: [84, -12], 3: [160, 55], 4: [500, -70],
}

function cornerSetup(end: 0 | 1, s: -1 | 1, kicker: TeamIndex, caps: PieceCap[], rules: Ruleset): { caps: Vec[]; ball: Vec } {
  const r = rOf
  const lineX = end === 0 ? 0 : W
  const inward = end === 0 ? 1 : -1
  const at = (depth: number, off: number): Vec => ({ x: lineX + inward * depth, y: H / 2 + s * off })
  const targets: Vec[] = caps.map(c => ({ x: c.x, y: c.y }))
  const active = caps.filter(c => c.active)
  const taker = active.find(c => c.team === kicker && c.slot === 3) ?? active.find(c => c.team === kicker && c.slot !== 0) ?? active.find(c => c.team === kicker)
  const aimAt = at(PITCH.penaltySpot, 0)
  let ball = at(BALL.radius + FOOTBALL.restartInset / 2, H / 2 - BALL.radius - FOOTBALL.restartInset / 2)
  let takerAt: Vec | null = null
  if (taker) {
    const tr = r(taker)
    for (let inset = BALL.radius + FOOTBALL.restartInset / 2; inset < 140; inset += 3) {
      const b = at(inset, H / 2 - inset)
      const dx = aimAt.x - b.x
      const dy = aimAt.y - b.y
      const d = Math.hypot(dx, dy)
      const gap = BALL.radius + tr + FOOTBALL.restartInset / 4
      const t = { x: b.x - (dx / d) * gap, y: b.y - (dy / d) * gap }
      if (t.x >= tr + 2 && t.x <= W - tr - 2 && t.y >= tr + 2 && t.y <= H - tr - 2) { ball = b; takerAt = t; break }
    }
  }
  const placed: Circle[] = [{ x: ball.x, y: ball.y, r: BALL.radius }]
  const put = (c: PieceCap, want: Vec, extra: Circle[] = []) => {
    const p = findFreeSpot(want, r(c), [...placed, ...extra], 3)
    targets[c.id] = p
    placed.push({ ...p, r: r(c) })
  }
  if (taker && takerAt) { targets[taker.id] = takerAt; placed.push({ ...takerAt, r: r(taker) }) }
  for (const c of active) {
    if (c.team !== kicker || c === taker) continue
    const spot = CORNER_ATTACK[c.slot]
    put(c, spot ? at(spot[0], spot[1]) : basePosition(c.team, c.slot))
  }
  const wall: Circle = { x: ball.x, y: ball.y, r: rules.wallDistance }
  for (const c of active) {
    if (c.team === kicker) continue
    const spot = CORNER_DEFEND[c.slot] ?? [120, 0]
    const depth = c.slot === 0 ? r(c) + FOOTBALL.keeperLineInset : spot[0]
    put(c, at(depth, spot[1]), [wall])
  }
  return { caps: targets, ball }
}
