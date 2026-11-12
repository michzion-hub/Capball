import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { INVITE_PROFILE, getOnlineProfile, profileInfo } from '../src/config/rulesets'
import type { RulesProfile } from '../src/config/rulesets'
import { FOOTBALL } from '../src/config/football'
import { legalKeeperPosition } from '../src/game/penalty'
import { PITCH, isSurfaceId } from '../src/config/tuning'
import type { SurfaceId } from '../src/config/tuning'
import { Match } from '../src/game/match'
import { defaultTeam, sanitizeTeam } from '../src/store/settings'
import type { TeamDesign } from '../src/render/capArt'
import type { TeamIndex } from '../src/physics/world'
import { ONLINE_BUILD, MAX_ONLINE_PACKET_BYTES, isFiniteNumber, isPenaltyChoice, isRecord, penaltyCommitText, safeRoomCode, sha256Hex } from '../src/net/protocol'
import type { NetworkBody, NetworkState, OnlinePhase, OnlineRole, PenaltyChoice } from '../src/net/protocol'

const HOST = process.env.HOST ?? '127.0.0.1'
const MAX_ROOMS = 128
const MAX_CONNECTIONS = 256
const ROOM_IDLE_MS = 10 * 60_000
const RESUME_GRACE_MS = 60_000
const PENALTY_COMMIT_MS = 20_000
const PENALTY_REVEAL_MS = 8_000
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const allowedOrigins = new Set((process.env.CAPBALL_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean))

interface SeatRecord { socket: WebSocket | null; token: string; disconnectedAt: number; lastActionId: number; rateStarted: number; rateCount: number }
const randomToken = () => randomBytes(18).toString('base64url')
function randomRoomCode(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('')
}
function send(ws: WebSocket, packet: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const text = JSON.stringify(packet)
  if (Buffer.byteLength(text) > MAX_ONLINE_PACKET_BYTES) { ws.close(1009, 'message too large'); return }
  if (ws.bufferedAmount > 64 * 1024) { ws.terminate(); return }
  ws.send(text)
}
function isRole(value: string): value is OnlineRole { return value === 'p1' || value === 'p2' }

interface PenaltyFlow {
  id: number
  kicker: 0 | 1
  takerId: number
  keeperId: number
  end: 0 | 1
  stage: 'commit' | 'reveal'
  deadline: number
  commit: [string | null, string | null]
  choice: [PenaltyChoice | null, PenaltyChoice | null]
  nonce: [string | null, string | null]
  revealed: [boolean, boolean]
}

export class OnlineRoom {  readonly seats: [SeatRecord, SeatRecord] = [
    { socket: null, token: '', disconnectedAt: 0, lastActionId: 0, rateStarted: 0, rateCount: 0 },
    { socket: null, token: '', disconnectedAt: 0, lastActionId: 0, rateStarted: 0, rateCount: 0 },
  ]
  readonly match: Match
  private stateSeq = 0
  private tickCount = 0
  lastActivity = Date.now()
  ready = false
  private readonly unsubs: (() => void)[] = []
  private goalEvent = 0
  private penalty: PenaltyFlow | null = null
  private penaltySeq = 0
  private resolvedPenaltyTurn = -1
  private readonly designs: [TeamDesign, TeamDesign] = [defaultTeam(0), defaultTeam(1)]
  private readonly designSet: [boolean, boolean] = [false, false]

  constructor(readonly code: string, readonly profile: RulesProfile, readonly surface: SurfaceId, private readonly onEmpty: (room: OnlineRoom) => void) {
    this.match = new Match({ ruleset: profile.ruleset, surface, firstTeam: 0 })
    this.match.paused = true
    this.unsubs.push(
      this.match.events.on('goal', g => {
        this.goalEvent++
        this.broadcast({ type: 'event', build: ONLINE_BUILD, room: this.code, seq: this.goalEvent, kind: 'goal', team: g.scorer, ownGoal: g.ownGoal, end: g.end, capId: g.capId, score: [...g.score.goals] })
      }),
      this.match.events.on('win', w => this.broadcast({ type: 'event', build: ONLINE_BUILD, room: this.code, seq: ++this.goalEvent, kind: 'win', team: w.team, score: [...w.score.goals] })),
    )
  }

  get hasSocket(): boolean { return this.seats.some(s => s.socket?.readyState === WebSocket.OPEN) }
  connected(): [boolean, boolean] { return this.seats.map(s => s.socket?.readyState === WebSocket.OPEN) as [boolean, boolean] }

  attach(ws: WebSocket, resume: string, design?: unknown): OnlineRole | null {
    this.lastActivity = Date.now()
    let index = resume ? this.seats.findIndex(s => s.token === resume
      && (s.socket?.readyState === WebSocket.OPEN || (!!s.disconnectedAt && Date.now() - s.disconnectedAt <= RESUME_GRACE_MS))) : -1
    if (resume && index < 0) return null
    if (index < 0) index = this.seats.findIndex(s => !s.token)
    if (index < 0) return null
    const seat = this.seats[index]
    if (design !== undefined && !this.designSet[index]) {
      this.designs[index] = sanitizeTeam(design, index as 0 | 1)
      this.designSet[index] = true
    }
    if (seat.socket && seat.socket.readyState === WebSocket.OPEN) seat.socket.close(4001, 'seat resumed elsewhere')
    if (!seat.token) seat.token = randomToken()
    seat.socket = ws
    seat.disconnectedAt = 0
    const role: OnlineRole = index === 0 ? 'p1' : 'p2'
    ;(ws as WebSocket & { capballRole?: OnlineRole }).capballRole = role
    const before = this.ready
    this.ready = this.connected().every(Boolean)
    this.match.paused = !this.ready
    send(ws, { type: 'welcome', build: ONLINE_BUILD, room: this.code, role, token: seat.token, state: this.state() })
    ws.on('message', data => this.receive(ws, data))
    ws.on('close', () => this.detach(ws))
    ws.on('error', () => this.detach(ws))
    if (before !== this.ready || this.ready) this.broadcastState()
    return role
  }

  detach(ws: WebSocket): void {
    const role = (ws as WebSocket & { capballRole?: OnlineRole }).capballRole
    if (!role) return
    const index = role === 'p1' ? 0 : 1
    const seat = this.seats[index]
    if (seat.socket !== ws) return
    seat.socket = null
    seat.disconnectedAt = Date.now()
    this.lastActivity = Date.now()
    this.ready = this.connected().every(Boolean)
    this.match.paused = !this.ready
    this.broadcastState()
  }

  tick(): void {
    const now = Date.now()
    for (const seat of this.seats) {
      if (!seat.socket && seat.token && seat.disconnectedAt && now - seat.disconnectedAt > RESUME_GRACE_MS) {
        seat.token = ''
        seat.disconnectedAt = 0
        seat.lastActionId = 0
        this.designSet[this.seats.indexOf(seat)] = false
      }
    }
    if (!this.hasSocket && now - this.lastActivity > ROOM_IDLE_MS) { this.onEmpty(this); return }
    if (!this.ready) return
    if (this.penalty) { this.tickPenalty(now); return }
    this.match.update(1000 / 60)
    this.maybeStartPenalty(now)
    if (this.tickCount % 3 === 0) this.broadcastState()
    this.tickCount++
  }

  private maybeStartPenalty(now: number): void {
    const m = this.match
    if (this.penalty || m.phase !== 'aim' || m.reason !== 'penalty' || m.takerId < 0 || m.keeperId < 0) return
    if (m.turns.state.turn === this.resolvedPenaltyTurn) return
    this.penalty = {
      id: ++this.penaltySeq,
      kicker: m.team,
      takerId: m.takerId,
      keeperId: m.keeperId,
      end: (1 - m.team) as 0 | 1,
      stage: 'commit',
      deadline: now + PENALTY_COMMIT_MS,
      commit: [null, null],
      choice: [null, null],
      nonce: [null, null],
      revealed: [false, false],
    }
    this.match.paused = true
    this.broadcastState()
  }

  private tickPenalty(now: number): void {
    const flow = this.penalty
    if (!flow || now <= flow.deadline) return
    if (flow.stage === 'commit') {
      flow.stage = 'reveal'
      flow.deadline = now + PENALTY_REVEAL_MS
      this.broadcastState()
      return
    }
    this.resolvePenalty(flow)
  }

  private resolvePenalty(flow: PenaltyFlow): void {
    const m = this.match
    const keeper = flow.choice[1 - flow.kicker]
    const shot = flow.choice[flow.kicker]
    const keeperPosition = keeper?.kind === 'keeper'
      ? keeper.position
      : { x: flow.end === 0 ? 0 : PITCH.width, y: PITCH.height / 2 }
    const radius = m.world.capInfo(flow.keeperId).type.radius
    m.world.place(m.world.caps[flow.keeperId], legalKeeperPosition(keeperPosition, flow.end, radius, m.ruleset.keeperMayLeaveLine), 0)
    const forfeited = shot?.kind === 'shot' ? !!shot.forfeited : false
    const direction = shot?.kind === 'shot'
      ? { ...shot.direction }
      : { x: flow.end === 0 ? -1 : 1, y: 0 }
    const power = shot?.kind === 'shot' ? shot.power : FOOTBALL.timeoutStraightPower
    this.penalty = null
    this.resolvedPenaltyTurn = m.turns.state.turn
    m.paused = false
    const keeperView = { x: m.world.caps[flow.keeperId].position.x, y: m.world.caps[flow.keeperId].position.y }
    m.tryFlick(flow.takerId, direction, power, 0)
    this.broadcast({
      type: 'penalty-shot', build: ONLINE_BUILD, room: this.code, penaltyId: flow.id,
      kicker: flow.kicker, takerId: flow.takerId, keeperId: flow.keeperId,
      keeper: keeperView, shot: { direction, power, forfeited },
    })
    this.broadcastState()
  }

  state(): NetworkState {
    const match = this.match
    const ready = this.ready
    const bodies = match.world.snapshot()
    const packed: NetworkBody[] = [...bodies.caps, bodies.ball]
    const phase: OnlinePhase = ready ? match.phase : 'waiting'
    return {
      build: ONLINE_BUILD, room: this.code, seq: ++this.stateSeq, ready, connected: this.connected(), profile: profileInfo(this.profile),
      teams: this.designs.map(d => ({ name: d.name, primary: d.primary, secondary: d.secondary, pattern: d.pattern, numbers: [...d.numbers], capNames: [...d.capNames] })) as NetworkState['teams'],
      surface: this.surface,
      penalty: this.penalty ? {
        id: this.penalty.id, stage: this.penalty.stage, kicker: this.penalty.kicker,
        takerId: this.penalty.takerId, keeperId: this.penalty.keeperId, end: this.penalty.end,
        committed: [!!this.penalty.commit[0], !!this.penalty.commit[1]], deadline: this.penalty.deadline,
      } : null,
      phase,
      team: match.team, reason: match.reason, turn: match.turns.state.turn, flicks: match.turns.state.flicks,
      score: [...match.score.goals],
      possession: { chain: [...match.possession.chain], powerReady: [...match.possession.powerReady], lastCap: match.possession.lastCap?.id ?? null },
      armed: match.armed, activeCap: match.activeCap, bodies: packed,
      winner: match.phase === 'over' ? (match.score.goals[0] >= match.score.goals[1] ? 0 : 1) : null,
    }
  }

  private broadcast(packet: unknown): void { for (const s of this.seats) if (s.socket) send(s.socket, packet) }
  private broadcastState(): void { this.broadcast({ type: 'state', build: ONLINE_BUILD, state: this.state() }) }

  private fail(ws: WebSocket, code: string, message: string): void {
    send(ws, { type: 'error', build: ONLINE_BUILD, code, message })
    this.broadcastState()
  }

  private receive(ws: WebSocket, data: RawData): void {
    const role = (ws as WebSocket & { capballRole?: OnlineRole }).capballRole
    if (!role) return
    const seat = this.seats[role === 'p1' ? 0 : 1]
    const now = Date.now()
    if (now - seat.rateStarted >= 1000) { seat.rateStarted = now; seat.rateCount = 0 }
    if (++seat.rateCount > 24) { ws.close(1008, 'message rate limit'); return }
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
    if (Buffer.byteLength(text) > MAX_ONLINE_PACKET_BYTES) { ws.close(1009, 'message too large'); return }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { this.fail(ws, 'invalid', 'That message was not valid JSON.'); return }
    if (!isRecord(raw) || raw.build !== ONLINE_BUILD || raw.room !== this.code) { this.fail(ws, 'invalid', 'That message does not match this CAPBALL room.'); return }
    if (raw.type === 'ping' && Number.isSafeInteger(raw.t) && (raw.t as number) >= 0) { send(ws, { type: 'pong', build: ONLINE_BUILD, t: raw.t }); return }
    if (raw.type === 'penalty') { void this.receivePenalty(ws, raw, role, seat); return }
    if (raw.type !== 'flick') { this.fail(ws, 'invalid', 'Only flicks, penalties and pings are accepted.'); return }
    if (!isRole(role)) return
    const team: TeamIndex = role === 'p1' ? 0 : 1
    if (!this.ready) { this.fail(ws, 'not_ready', 'Waiting for the other player to reconnect.'); return }
    const id = raw.actionId
    const capId = raw.capId
    const dir = raw.dir
    const power = raw.power
    const spin = raw.spin
    const arm = raw.arm
    if (!Number.isSafeInteger(id) || (id as number) <= seat.lastActionId || !Number.isInteger(capId) || (capId as number) < 0 || (capId as number) > 9
      || !isRecord(dir) || !isFiniteNumber(dir.x) || !isFiniteNumber(dir.y) || Math.abs(Math.hypot(dir.x, dir.y) - 1) > 0.02
      || !isFiniteNumber(power) || power < 0.05 || power > 1 || !isFiniteNumber(spin) || Math.abs(spin) > 1 || typeof arm !== 'boolean') {
      this.fail(ws, 'invalid', 'That flick has invalid values.'); return
    }
    if (this.match.team !== team || this.match.phase !== 'aim' || this.match.turns.state.flicks !== 0 || this.match.world.capInfo(capId as number).team !== team) {
      this.fail(ws, 'wrong_turn', 'It is not your turn or that cap is not yours.'); return
    }
    if (arm && !this.match.canArm(team)) { this.fail(ws, 'invalid', 'That power shot is not charged.'); return }
    if (arm) this.match.toggleArm()
    if (!this.match.tryFlick(capId as number, dir as { x: number; y: number }, power, spin)) { this.fail(ws, 'wrong_turn', 'That flick was not accepted.'); return }
    seat.lastActionId = id as number
    this.broadcast({ type: 'flick', build: ONLINE_BUILD, room: this.code, actionId: id, team, capId, dir, power, spin, arm })
    send(ws, { type: 'accepted', build: ONLINE_BUILD, actionId: id })
    this.broadcastState()
  }

  private async receivePenalty(ws: WebSocket, raw: Record<string, unknown>, role: OnlineRole, seat: SeatRecord): Promise<void> {
    const flow = this.penalty
    if (!flow) { this.fail(ws, 'wrong_turn', 'No penalty is in progress.'); return }
    const id = raw.actionId
    if (!Number.isSafeInteger(id) || (id as number) <= seat.lastActionId) { this.fail(ws, 'invalid', 'That penalty action is out of date.'); return }
    if (raw.penaltyId !== flow.id) { this.fail(ws, 'wrong_turn', 'That penalty has already been settled.'); return }
    const team: TeamIndex = role === 'p1' ? 0 : 1
    const expected = team === flow.kicker ? 'shot' : 'keeper'
    if (raw.stage === 'commit') {
      if (flow.stage !== 'commit') { this.fail(ws, 'wrong_turn', 'Both players have already locked their choices.'); return }
      if (flow.commit[team]) { this.fail(ws, 'invalid', 'Your choice is already locked.'); return }
      const commit = raw.commit
      if (typeof commit !== 'string' || !/^[a-f0-9]{64}$/.test(commit)) { this.fail(ws, 'invalid', 'That commitment is invalid.'); return }
      flow.commit[team] = commit
      seat.lastActionId = id as number
      send(ws, { type: 'accepted', build: ONLINE_BUILD, actionId: id })
      if (flow.commit[0] && flow.commit[1]) {
        flow.stage = 'reveal'
        flow.deadline = Date.now() + PENALTY_REVEAL_MS
      }
      this.broadcastState()
      return
    }
    if (raw.stage === 'reveal') {
      if (flow.stage !== 'reveal') { this.fail(ws, 'wrong_turn', 'Wait for both players to lock in.'); return }
      if (!flow.commit[team] || flow.revealed[team]) { this.fail(ws, 'invalid', 'That reveal was not expected.'); return }
      const choice = raw.choice
      const nonce = raw.nonce
      if (!isPenaltyChoice(choice) || choice.kind !== expected || typeof nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(nonce)) {
        this.fail(ws, 'invalid', 'That penalty reveal is invalid.'); return
      }
      const digest = await sha256Hex(penaltyCommitText(flow.id, team, choice, nonce))
      if (this.penalty !== flow || flow.commit[team] !== digest) { this.fail(ws, 'invalid', 'That reveal does not match your commitment.'); return }
      flow.choice[team] = choice
      flow.nonce[team] = nonce
      flow.revealed[team] = true
      seat.lastActionId = id as number
      send(ws, { type: 'accepted', build: ONLINE_BUILD, actionId: id })
      if (flow.revealed[0] && flow.revealed[1]) this.resolvePenalty(flow)
      else this.broadcastState()
      return
    }
    this.fail(ws, 'invalid', 'That penalty stage is invalid.')
  }

  destroy(): void {
    this.unsubs.forEach(unsub => unsub())
    this.match.destroy()
    for (const seat of this.seats) seat.socket?.close(1001, 'room closed')
  }
}

export interface OnlineServerOptions { host?: string; port?: number; allowedOrigins?: string[] }
export interface OnlineServer { host: string; port: number; url: string; close(): Promise<void>; roomCount(): number; room(code: string): OnlineRoom | undefined }

export async function startOnlineServer(options: OnlineServerOptions = {}): Promise<OnlineServer> {
  const host = options.host ?? HOST
  const port = options.port ?? Number(process.env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid CAPBALL multiplayer port')
  const allow = new Set(options.allowedOrigins ?? [...allowedOrigins])
  const rooms = new Map<string, OnlineRoom>()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`).pathname
    if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, build: ONLINE_BUILD, rooms: rooms.size })); return }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('CAPBALL online service')
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_ONLINE_PACKET_BYTES, perMessageDeflate: false })
  sockets.on('connection', ws => {
    const state = ws as WebSocket & { isAlive?: boolean }
    state.isAlive = true
    ws.on('pong', () => { state.isAlive = true })
  })
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (sockets.clients.size >= MAX_CONNECTIONS) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const origin = req.headers.origin
    if (!origin || !allow.has(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
    if (url.pathname !== '/ws' || url.search) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      let joined = false
      const handshakeTimer = setTimeout(() => { if (!joined) ws.close(1008, 'join packet required') }, 5000)
      ws.once('message', data => {
        clearTimeout(handshakeTimer)
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
        let raw: unknown
        try { raw = JSON.parse(text) } catch { ws.close(1008, 'invalid join packet'); return }
        if (!isRecord(raw) || raw.type !== 'join' || raw.build !== ONLINE_BUILD
          || (raw.room !== undefined && typeof raw.room !== 'string')
          || (raw.token !== undefined && typeof raw.token !== 'string')) { ws.close(1008, 'invalid join packet'); return }
        const requested = typeof raw.room === 'string' ? raw.room.toUpperCase() : ''
        const resume = typeof raw.token === 'string' ? raw.token : ''
        if ((requested && !safeRoomCode(requested)) || (resume && (!requested || resume.length < 16 || resume.length > 128))) {
          send(ws, { type: 'error', build: ONLINE_BUILD, code: 'invalid', message: 'Room code or reconnect credential is invalid.' }); ws.close(1008, 'invalid join'); return
        }
        let room: OnlineRoom | undefined
        if (requested) room = rooms.get(requested)
        else if (!resume) {
          if (rooms.size >= MAX_ROOMS) { send(ws, { type: 'error', build: ONLINE_BUILD, code: 'room_full', message: 'No CAPBALL rooms are available right now.' }); ws.close(1008, 'room limit'); return }
          const profile = raw.profile === undefined
            ? INVITE_PROFILE
            : isRecord(raw.profile) ? getOnlineProfile(raw.profile.id, raw.profile.version) : null
          if (!profile) { send(ws, { type: 'error', build: ONLINE_BUILD, code: 'invalid', message: 'That online rules profile is not supported by this server.' }); ws.close(1008, 'invalid rules profile'); return }
          let code: string
          do { code = randomRoomCode() } while (rooms.has(code))
          const surface: SurfaceId = isSurfaceId(raw.surface) ? raw.surface : 'park'
          room = new OnlineRoom(code, profile, surface, r => { r.destroy(); rooms.delete(r.code) })
          rooms.set(code, room)
        }
        if (!room) { send(ws, { type: 'error', build: ONLINE_BUILD, code: resume ? 'invalid' : 'room_full', message: resume ? 'That reconnect credential has expired.' : 'That room code is unavailable.' }); ws.close(1008, 'room unavailable'); return }
        const role = room.attach(ws, resume, raw.design)
        if (!role) { send(ws, { type: 'error', build: ONLINE_BUILD, code: resume ? 'invalid' : 'room_full', message: resume ? 'That reconnect credential has expired.' : 'This room already has two players.' }); ws.close(1008, 'seat unavailable'); return }
        joined = true
      })
    })
  })
  const timer = setInterval(() => { for (const room of rooms.values()) room.tick() }, 1000 / 60)
  timer.unref()
  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      const state = client as WebSocket & { isAlive?: boolean }
      if (state.isAlive === false) { client.terminate(); continue }
      state.isAlive = false
      client.ping()
    }
  }, 30_000)
  heartbeat.unref()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => { server.off('error', rejectListen); resolveListen() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to bind CAPBALL multiplayer server')
  const actualPort = address.port
  if (process.env.CAPBALL_SERVER_READY === '1') console.log(JSON.stringify({ ready: true, host, port: actualPort }))
  return {
    host, port: actualPort, url: `ws://${host}:${actualPort}/ws`,
    roomCount: () => rooms.size,
    room: (code: string) => rooms.get(code.toUpperCase()),
    close: async () => {
      clearInterval(timer)
      clearInterval(heartbeat)
      for (const room of rooms.values()) room.destroy()
      rooms.clear()
      sockets.close()
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
    },
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const online = await startOnlineServer()
  if (process.env.CAPBALL_SERVER_READY !== '1') console.log(JSON.stringify({ ready: true, host: online.host, port: online.port }))
  const stop = () => void online.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
