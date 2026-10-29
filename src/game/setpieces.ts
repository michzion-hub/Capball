import { CAP_TYPES, BALL, DEADBALL, PITCH } from '../config/tuning'
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

/**
 * Where everything should slide to before a set piece. Returns targets for every cap (same order)
 * and the ball. Pure; positions only ever change between plays.
 */
export function setPieceTargets(o: Outcome, caps: PieceCap[], _ball: Vec, rules: Ruleset): { caps: Vec[]; ball: Vec } | null {
  if (o.kind === 'normal' || o.kind === 'bonus') return null
  const kicker = o.next
  const targets: Vec[] = caps.map(c => ({ x: c.x, y: c.y }))
  let ballAt: Vec
  const r = (c: PieceCap) => CAP_TYPES[c.type].radius

  if (o.kind === 'penalty') {
    const lineX = o.end === 0 ? 0 : W
    const inward = o.end === 0 ? 1 : -1
    ballAt = { x: lineX + inward * PITCH.penaltySpot, y: H / 2 }
    const defenders = o.end === 0 ? 0 : 1
    const boxDepth = PITCH.penaltyBox.depth
    const placed: Circle[] = [{ x: ballAt.x, y: ballAt.y, r: BALL.radius }]
    // Keeper on the line, striker (or first active attacker) behind the ball.
    const keeper = caps.find(c => c.team === defenders && c.slot === 0 && c.active)
    const taker = caps.find(c => c.team === kicker && c.slot === 4 && c.active) ?? caps.find(c => c.team === kicker && c.active)
    if (keeper) { targets[keeper.id] = { x: lineX + inward * (r(keeper) + 3), y: H / 2 }; placed.push({ ...targets[keeper.id], r: r(keeper) }) }
    // Taker stands further from the goal than the ball (toward the pitch centre).
    if (taker) { targets[taker.id] = { x: ballAt.x + inward * (BALL.radius + r(taker) + 26), y: H / 2 }; placed.push({ ...targets[taker.id], r: r(taker) }) }
    // Everyone else outside the box.
    for (const c of caps) {
      if (!c.active || c === keeper || c === taker) continue
      let p = { x: c.x, y: c.y }
      const insideX = o.end === 0 ? p.x < boxDepth + r(c) + 6 : p.x > W - boxDepth - r(c) - 6
      if (insideX) p = { x: lineX + inward * (boxDepth + r(c) + 10 + Math.random() * 0), y: p.y }
      p = findFreeSpot(p, r(c), placed, 6)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    return { caps: targets, ball: ballAt }
  }

  if (o.kind === 'dropball') {
    // Dropped ball: nobody gets a free run at it — every cap is moved clear of the drop spot.
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
  // Ball spot for the other set pieces.
  if (o.kind === 'freekick') {
    ballAt = clampToPitch(o.at, BALL.radius + 14)
  } else {
    // goal kick: edge of the goal box on the side it went out
    const x = o.end === 0 ? PITCH.goalBox.depth : W - PITCH.goalBox.depth
    const y = o.at.y < H / 2 ? H / 2 - 60 : H / 2 + 60
    ballAt = { x, y }
    // Goal kick = fresh shape: every cap slides back to its original formation spot.
    const placed: Circle[] = []
    for (const c of caps) {
      if (!c.active) continue
      const p = findFreeSpot(basePosition(c.team, c.slot), r(c), placed, 4)
      targets[c.id] = p
      placed.push({ ...p, r: r(c) })
    }
    ballAt = findFreeSpot(ballAt, BALL.radius, placed, 3)
    return { caps: targets, ball: ballAt }
  }
  // Ball must not overlap any cap (kicking team's caps can stay put; they're the ones pushed if needed).
  ballAt = findFreeSpot(ballAt, BALL.radius, caps.filter(c => c.active).map(c => ({ x: c.x, y: c.y, r: r(c) })), 3)

  // Defending caps must retreat to the wall distance.
  const wall = rules.wallDistance
  const placed: Circle[] = [{ x: ballAt.x, y: ballAt.y, r: BALL.radius }]
  for (const c of caps) if (c.active && c.team === kicker) placed.push({ x: c.x, y: c.y, r: r(c) })
  const dirKick = attackDir(kicker)
  for (const c of caps) {
    if (!c.active || c.team === kicker) continue
    const d = Math.hypot(c.x - ballAt.x, c.y - ballAt.y)
    let p = { x: c.x, y: c.y }
    if (d < wall + r(c)) {
      // Push straight away from the ball (toward their own goal if exactly on top).
      const ux = d > 1e-3 ? (c.x - ballAt.x) / d : dirKick
      const uy = d > 1e-3 ? (c.y - ballAt.y) / d : 0
      p = { x: ballAt.x + ux * (wall + r(c) + 2), y: ballAt.y + uy * (wall + r(c) + 2) }
    }
    const obstacles = [...placed, { x: ballAt.x, y: ballAt.y, r: wall }]
    p = findFreeSpot(p, r(c), obstacles, 4)
    targets[c.id] = p
    placed.push({ ...p, r: r(c) })
  }
  return { caps: targets, ball: ballAt }
}

/**
 * Corner shape, as (depth from the goal line, offset from the centre line toward the corner side).
 * Slots: 0 keeper, 1–2 defenders, 3 winger, 4 striker. `s` = +1 bottom corner, -1 top corner.
 */
const CORNER_ATTACK: Record<number, [number, number]> = {
  4: [112, -30],   // striker: penalty spot, far side
  2: [58, 70],     // defender: attacking the near post
  1: [190, 15],    // defender: edge of the box for the knock-down
}
const CORNER_DEFEND: Record<number, [number, number]> = {
  0: [0, 18],      // keeper: on the line, shading the near post (depth = line + radius)
  1: [34, 98],     // defender: near post
  2: [84, -12],    // defender: goal-side of the striker
  3: [160, 55],    // winger: edge of the box, blocking the short ball
  4: [500, -70],   // striker: halfway line, waiting for the counter
}

function cornerSetup(end: 0 | 1, s: -1 | 1, kicker: TeamIndex, caps: PieceCap[], rules: Ruleset): { caps: Vec[]; ball: Vec } {
  const r = (c: PieceCap) => CAP_TYPES[c.type].radius
  const lineX = end === 0 ? 0 : W
  const inward = end === 0 ? 1 : -1
  const at = (depth: number, off: number): Vec => ({ x: lineX + inward * depth, y: H / 2 + s * off })
  const targets: Vec[] = caps.map(c => ({ x: c.x, y: c.y }))
  const active = caps.filter(c => c.active)
  const taker = active.find(c => c.team === kicker && c.slot === 3) ?? active.find(c => c.team === kicker && c.slot !== 0) ?? active.find(c => c.team === kicker)
  // Ball near the corner flag, far enough in that the taker fits behind it aiming at the penalty spot.
  const aimAt = at(PITCH.penaltySpot, 0)
  let ball = at(BALL.radius + 6, H / 2 - BALL.radius - 6)
  let takerAt: Vec | null = null
  if (taker) {
    const tr = r(taker)
    for (let inset = BALL.radius + 6; inset < 140; inset += 3) {
      const b = at(inset, H / 2 - inset)
      const dx = aimAt.x - b.x
      const dy = aimAt.y - b.y
      const d = Math.hypot(dx, dy)
      const gap = BALL.radius + tr + 3
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
  // Attackers crowd the box; their keeper stays home.
  for (const c of active) {
    if (c.team !== kicker || c === taker) continue
    const spot = CORNER_ATTACK[c.slot]
    put(c, spot ? at(spot[0], spot[1]) : basePosition(c.team, c.slot))
  }
  // Defenders mark, all at least the wall distance from the ball.
  const wall: Circle = { x: ball.x, y: ball.y, r: rules.wallDistance }
  for (const c of active) {
    if (c.team === kicker) continue
    const spot = CORNER_DEFEND[c.slot] ?? [120, 0]
    const depth = c.slot === 0 ? r(c) + 3 : spot[0]
    put(c, at(depth, spot[1]), [wall])
  }
  return { caps: targets, ball }
}
