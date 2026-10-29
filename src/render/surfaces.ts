import { PITCH } from '../config/tuning'
import type { SurfaceId } from '../config/tuning'

const { width: W, height: H, goalWidth: GW, goalDepth: GD, viewMargin: M } = PITCH
const GT = (H - GW) / 2
const GB = (H + GW) / 2

/** Deterministic RNG so textures never flicker between redraws. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Look {
  surround: string
  base: string
  stripeA: string
  stripeB: string
  line: string
  board: string
  boardEdge: string
  grit: string[]
  gritCount: number
  lineWobble: number
  tags: string[]
}

const LOOKS: Record<SurfaceId, Look> = {
  park: { surround: '#2b2a2e', base: '#5f8f3e', stripeA: '#6a9a45', stripeB: '#5a8939', line: 'rgba(250,248,235,0.92)', board: '#8a5a32', boardEdge: '#5b3a1f', grit: ['#4f7a33', '#7aa653', '#8f8a5a'], gritCount: 900, lineWobble: 1.2, tags: ['NO BALL GAMES', 'CAPBALL', 'KEEP OFF THE GRASS'] },
  dusty: { surround: '#3a332c', base: '#c49b68', stripeA: '#c9a170', stripeB: '#be955f', line: 'rgba(255,250,236,0.85)', board: '#6f6a64', boardEdge: '#4a4640', grit: ['#a87f4f', '#d9b98a', '#8d6a43', '#e8d2a8'], gritCount: 2600, lineWobble: 2.4, tags: ['LOT 9', 'NO PARKING', 'CAPBALL'] },
  rooftop: { surround: '#1c2129', base: '#4a4d55', stripeA: '#50535b', stripeB: '#45484f', line: 'rgba(255,214,64,0.9)', board: '#9a968e', boardEdge: '#6c6962', grit: ['#3d4047', '#5d6068', '#6b6e75'], gritCount: 1400, lineWobble: 0.6, tags: ['DANGER: EDGE', 'HVAC', 'CAPBALL'] },
  court: { surround: '#141a2a', base: '#2a7ab8', stripeA: '#2f84c4', stripeB: '#2a7ab8', line: 'rgba(255,255,255,0.96)', board: '#e2483d', boardEdge: '#9b2a22', grit: ['#3a8dce'], gritCount: 120, lineWobble: 0, tags: ['WET FLOOR', 'CAPBALL', 'NO SKATING'] },
  slope: { surround: '#2e2a26', base: '#6f9440', stripeA: '#79a04a', stripeB: '#688b3b', line: 'rgba(250,248,235,0.9)', board: '#7b5233', boardEdge: '#52341d', grit: ['#5b7d33', '#8bb05a', '#9b9161'], gritCount: 900, lineWobble: 1.6, tags: ['DOWNHILL ↓', 'CAPBALL', 'MIND THE HILL'] },
}

export function surfaceAccent(id: SurfaceId): string { return LOOKS[id].line }

function wobbleLine(ctx: CanvasRenderingContext2D, pts: [number, number][], wob: number, r: () => number): void {
  ctx.beginPath()
  pts.forEach(([x, y], i) => {
    const ox = (r() - 0.5) * wob
    const oy = (r() - 0.5) * wob
    if (i === 0) ctx.moveTo(x + ox, y + oy)
    else ctx.lineTo(x + ox, y + oy)
  })
  ctx.stroke()
}

function segs(x0: number, y0: number, x1: number, y1: number, n = 10): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n] as [number, number])
}

/** Draws the full static backdrop in world units: surround, surface, markings, boards. */
export function drawPitch(ctx: CanvasRenderingContext2D, id: SurfaceId): void {
  const L = LOOKS[id]
  const r = rng(id.length * 7919 + 17)

  // Surround (street / roof / gym floor)
  ctx.fillStyle = L.surround
  ctx.fillRect(-M * 3, -M * 3, W + M * 6, H + M * 6)
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.05})`
    ctx.fillRect(-M + r() * (W + 2 * M), -M + r() * (H + 2 * M), 1.5, 1.5)
  }

  // Surface (pitch + goal mouths)
  ctx.fillStyle = L.base
  ctx.fillRect(0, 0, W, H)
  ctx.fillRect(-GD, GT, GD, GW)
  ctx.fillRect(W, GT, GD, GW)
  if (id === 'court') {
    for (let x = 0; x < W; x += 40) { ctx.fillStyle = (x / 40) % 2 ? L.stripeA : L.stripeB; ctx.fillRect(x, 0, 40, H) }
  } else if (id === 'rooftop') {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1.5
    for (let y = 0; y < H; y += 62) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(r() * W, r() * H, 20 + r() * 50, 10 + r() * 22, r() * 3, 0, Math.PI * 2); ctx.fill() }
  } else {
    const n = 12
    for (let i = 0; i < n; i++) { ctx.fillStyle = i % 2 ? L.stripeA : L.stripeB; ctx.fillRect((W / n) * i, 0, W / n + 0.5, H) }
  }
  for (let i = 0; i < L.gritCount; i++) {
    ctx.fillStyle = L.grit[Math.floor(r() * L.grit.length)]
    ctx.globalAlpha = 0.25 + r() * 0.5
    const s = id === 'dusty' ? 1 + r() * 3.5 : 1 + r() * 2
    ctx.fillRect(r() * W, r() * H, s, s)
  }
  ctx.globalAlpha = 1
  if (id === 'dusty') {
    // tyre tracks + puddle stains
    ctx.strokeStyle = 'rgba(80,55,30,0.18)'
    ctx.lineWidth = 14
    ctx.beginPath(); ctx.moveTo(-20, 520); ctx.bezierCurveTo(300, 380, 600, 640, 1020, 430); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(-20, 545); ctx.bezierCurveTo(300, 405, 600, 665, 1020, 455); ctx.stroke()
  }
  if (id === 'court') {
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(0.55, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }
  if (id === 'slope') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, 'rgba(255,255,220,0.16)'); g.addColorStop(1, 'rgba(0,0,0,0.22)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    // chalked downhill chevrons
    ctx.strokeStyle = 'rgba(255,255,240,0.32)'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    for (const x of [250, 750]) {
      for (const y of [150, 190, 230]) {
        ctx.beginPath(); ctx.moveTo(x - 22, y); ctx.lineTo(x, y + 18); ctx.lineTo(x + 22, y); ctx.stroke()
      }
    }
    for (const x of [250, 750]) for (const y of [400, 440, 480]) {
      ctx.beginPath(); ctx.moveTo(x - 22, y); ctx.lineTo(x, y + 18); ctx.lineTo(x + 22, y); ctx.stroke()
    }
  }

  // Markings
  ctx.strokeStyle = L.line
  ctx.lineWidth = 3.4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const wob = L.lineWobble
  wobbleLine(ctx, [...segs(0, 0, W, 0), ...segs(W, 0, W, H).slice(1), ...segs(W, H, 0, H).slice(1), ...segs(0, H, 0, 0).slice(1)], wob, r)
  wobbleLine(ctx, segs(W / 2, 0, W / 2, H), wob, r)
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, PITCH.centerCircle, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = L.line
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 4, 0, Math.PI * 2); ctx.fill()
  for (const end of [0, 1]) {
    const x0 = end === 0 ? 0 : W
    const s = end === 0 ? 1 : -1
    const pb = PITCH.penaltyBox
    const gb = PITCH.goalBox
    wobbleLine(ctx, [[x0, (H - pb.width) / 2], [x0 + s * pb.depth, (H - pb.width) / 2], [x0 + s * pb.depth, (H + pb.width) / 2], [x0, (H + pb.width) / 2]], wob, r)
    wobbleLine(ctx, [[x0, (H - gb.width) / 2], [x0 + s * gb.depth, (H - gb.width) / 2], [x0 + s * gb.depth, (H + gb.width) / 2], [x0, (H + gb.width) / 2]], wob, r)
    ctx.beginPath(); ctx.arc(x0 + s * PITCH.penaltySpot, H / 2, 3.5, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath()
    ctx.arc(x0 + s * PITCH.penaltySpot, H / 2, 72, end === 0 ? -0.93 : Math.PI - 0.93 + 0, end === 0 ? 0.93 : Math.PI + 0.93)
    // only the part outside the box
    ctx.save()
    ctx.beginPath()
    ctx.rect(end === 0 ? pb.depth : 0, 0, end === 0 ? W : W - pb.depth, H)
    ctx.clip()
    ctx.beginPath()
    ctx.arc(x0 + s * PITCH.penaltySpot, H / 2, 72, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    for (const cy of [0, H]) {
      ctx.beginPath()
      ctx.arc(x0, cy, 16, 0, Math.PI * 2)
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); ctx.beginPath(); ctx.arc(x0, cy, 16, 0, Math.PI * 2); ctx.stroke(); ctx.restore()
    }
  }

  // Boards (visual thickness outside the physics face at the pitch edge)
  const BT = 18
  const board = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = L.board
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = L.boardEdge
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
    // plank seams / panel joints
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1.2
    const horizontal = w > h
    for (let t = 40 + r() * 40; t < (horizontal ? w : h); t += 70 + r() * 60) {
      ctx.beginPath()
      if (horizontal) { ctx.moveTo(x + t, y); ctx.lineTo(x + t, y + h) } else { ctx.moveTo(x, y + t); ctx.lineTo(x + w, y + t) }
      ctx.stroke()
    }
  }
  board(-GD - BT, -BT, W + 2 * (GD + BT), BT)
  board(-GD - BT, H, W + 2 * (GD + BT), BT)
  board(-BT, 0, BT, GT)
  board(-BT, GB, BT, H - GB)
  board(W, 0, BT, GT)
  board(W, GB, BT, H - GB)
  // goal frame boxes (behind the net)
  ctx.fillStyle = L.boardEdge
  ctx.fillRect(-GD - BT, GT - 6, BT, GW + 12)
  ctx.fillRect(W + GD, GT - 6, BT, GW + 12)
  ctx.fillRect(-GD, GT - 6, GD, 6)
  ctx.fillRect(-GD, GB, GD, 6)
  ctx.fillRect(W, GT - 6, GD, 6)
  ctx.fillRect(W, GB, GD, 6)

  // Graffiti tags on the boards
  ctx.save()
  ctx.font = '14px "Permanent Marker", cursive'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  const tagCols = ['#ffe14d', '#ff5a1f', '#ffffff', '#7cf5c4']
  L.tags.forEach((t, i) => {
    ctx.fillStyle = tagCols[i % tagCols.length]
    ctx.globalAlpha = 0.85
    ctx.fillText(t, 170 + i * 330, -BT / 2 + 1)
    ctx.fillText(t, W - 170 - i * 330, H + BT / 2 + 1)
  })
  ctx.restore()
}

/** Drawn every frame above the ball: goal nets and posts. */
export function drawGoals(ctx: CanvasRenderingContext2D): void {
  for (const end of [0, 1]) {
    const x0 = end === 0 ? -GD : W
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0, GT, GD, GW)
    ctx.clip()
    ctx.strokeStyle = 'rgba(255,255,255,0.42)'
    ctx.lineWidth = 1.1
    for (let k = -GW; k < GW + GD; k += 9) {
      ctx.beginPath(); ctx.moveTo(x0 + k, GT); ctx.lineTo(x0 + k - GW, GB); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x0 + k - GW, GT); ctx.lineTo(x0 + k, GB); ctx.stroke()
    }
    ctx.restore()
    const lx = end === 0 ? 0 : W
    for (const py of [GT, GB]) {
      ctx.beginPath()
      ctx.arc(lx, py, PITCH.postRadius, 0, Math.PI * 2)
      ctx.fillStyle = '#f4f1e8'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#3a3a3a'
      ctx.stroke()
    }
    // crossbar shadow line
    ctx.strokeStyle = 'rgba(240,238,228,0.9)'
    ctx.lineWidth = 4
    ctx.beginPath(); ctx.moveTo(lx, GT); ctx.lineTo(lx, GB); ctx.stroke()
  }
}
