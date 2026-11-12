import { ONLINE_BUILD, MAX_ONLINE_PACKET_BYTES, isFiniteNumber, isNetworkTeamDesign, isRecord, safeRoomCode } from './protocol'
import type { FlickMessage, NetworkBody, NetworkState, NetworkTeamDesign, OnlineRole, PenaltyChoice, PenaltyShotMessage, ServerMessage, StateMessage, Welcome } from './protocol'
import { OnlineDiagnostics } from './diagnostics'
import type { OnlineDiagnosticsView } from './diagnostics'
import { INVITE_PROFILE } from '../config/rulesets'
import { isSurfaceId } from '../config/tuning'
import type { SurfaceId } from '../config/tuning'

export type LinkState = 'idle' | 'discovering' | 'connecting' | 'open' | 'retrying' | 'unavailable' | 'closed'
export interface OnlineHooks {
  status(state: LinkState, detail?: string): void
  message(message: ServerMessage): void
  lost(code: number): void
}

export const ONLINE_NOT_CONFIGURED = 'Online service is not configured for this build.'
export type OnlineConfig = { ok: true; endpoint: string } | { ok: false; reason: string }

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return url.pathname === '/ws' && !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'wss:' || (local && url.protocol === 'ws:'))
  } catch { return false }
}
function validBody(value: unknown): value is NetworkBody {
  if (!isRecord(value)) return false
  const keys = ['x', 'y', 'angle', 'vx', 'vy', 'angularVelocity']
  return keys.every(k => isFiniteNumber(value[k]))
    && Math.abs(value.x as number) < 1500 && Math.abs(value.y as number) < 900
    && Math.abs(value.vx as number) < 200 && Math.abs(value.vy as number) < 200
    && Math.abs(value.angularVelocity as number) < 100 && typeof value.active === 'boolean'
}
const pair = (value: unknown): value is [unknown, unknown] => Array.isArray(value) && value.length === 2

/**
 * Read the build's public room-service config without opening a socket.
 * Shared by the online help screen (so it can be honest before a click) and the live client.
 */
export async function probeOnlineConfig(): Promise<OnlineConfig> {
  try {
    const configUrl = new URL('multiplayer/bootstrap.json', location.href)
    configUrl.search = ''; configUrl.hash = ''
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const response = await fetch(configUrl, { cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(timeout))
    if (!response.ok || Number(response.headers.get('content-length')) > 4096) return { ok: false, reason: ONLINE_NOT_CONFIGURED }
    const config: unknown = await response.json()
    if (!isRecord(config) || config.version !== 1 || config.build !== ONLINE_BUILD || !validEndpoint(config.signalingUrl)) return { ok: false, reason: ONLINE_NOT_CONFIGURED }
    return { ok: true, endpoint: config.signalingUrl }
  } catch { return { ok: false, reason: ONLINE_NOT_CONFIGURED } }
}
function validPenalty(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value)) return false
  const committed = value.committed
  return Number.isSafeInteger(value.id) && (value.id as number) >= 1
    && (value.stage === 'commit' || value.stage === 'reveal')
    && (value.kicker === 0 || value.kicker === 1)
    && Number.isInteger(value.takerId) && (value.takerId as number) >= 0 && (value.takerId as number) < 10
    && Number.isInteger(value.keeperId) && (value.keeperId as number) >= 0 && (value.keeperId as number) < 10
    && (value.end === 0 || value.end === 1)
    && pair(committed) && committed.every(x => typeof x === 'boolean')
    && isFiniteNumber(value.deadline)
}
function validState(value: unknown): value is NetworkState {
  if (!isRecord(value)) return false
  const connected = value.connected
  const score = value.score
  const possession = value.possession
  const bodies = value.bodies
  const profile = value.profile
  const teams = value.teams
  if (!pair(connected) || !pair(score) || !isRecord(possession)) return false
  const chain = possession.chain
  const powerReady = possession.powerReady
  const phase = value.phase
  if (!pair(chain) || !pair(powerReady) || !Array.isArray(bodies)) return false
  return value.build === ONLINE_BUILD && safeRoomCode(value.room) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0
    && typeof value.ready === 'boolean' && connected.every(x => typeof x === 'boolean')
    && isRecord(profile) && typeof profile.id === 'string' && /^[a-z0-9-]{1,40}$/.test(profile.id)
    && Number.isSafeInteger(profile.version) && (profile.version as number) >= 1
    && typeof profile.name === 'string' && profile.name.length >= 1 && profile.name.length <= 80
    && pair(teams) && teams.every(isNetworkTeamDesign)
    && isSurfaceId(value.surface)
    && validPenalty(value.penalty)
    && ['waiting', 'aim', 'moving', 'goal', 'replay', 'reset', 'over'].includes(String(phase))
    && (value.team === 0 || value.team === 1) && typeof value.reason === 'string'
    && Number.isSafeInteger(value.turn) && (value.turn as number) >= 0 && Number.isSafeInteger(value.flicks) && (value.flicks as number) >= 0
    && score.every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 3)
    && chain.every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 99)
    && powerReady.every(x => typeof x === 'boolean')
    && (possession.lastCap === null || (Number.isInteger(possession.lastCap) && (possession.lastCap as number) >= 0 && (possession.lastCap as number) < 10))
    && (value.armed === null || value.armed === 0 || value.armed === 1)
    && (value.activeCap === null || (Number.isInteger(value.activeCap) && (value.activeCap as number) >= 0 && (value.activeCap as number) < 10))
    && bodies.length === 11 && bodies.every(validBody)
    && (value.winner === null || value.winner === 0 || value.winner === 1)
}
function validWelcome(value: Record<string, unknown>): boolean {
  return value.type === 'welcome' && value.build === ONLINE_BUILD && safeRoomCode(value.room)
    && (value.role === 'p1' || value.role === 'p2') && typeof value.token === 'string' && value.token.length >= 16 && value.token.length <= 128
    && validState(value.state)
}
function validFlick(value: Record<string, unknown>): value is Record<string, unknown> & FlickMessage {
  const d = value.dir
  return value.type === 'flick' && value.build === ONLINE_BUILD && safeRoomCode(value.room)
    && Number.isSafeInteger(value.actionId) && (value.actionId as number) > 0
    && (value.team === 0 || value.team === 1) && Number.isInteger(value.capId) && (value.capId as number) >= 0 && (value.capId as number) < 10
    && isRecord(d) && isFiniteNumber(d.x) && isFiniteNumber(d.y) && Math.abs(Math.hypot(d.x, d.y) - 1) < 0.03
    && isFiniteNumber(value.power) && value.power >= 0.05 && value.power <= 1
    && isFiniteNumber(value.spin) && Math.abs(value.spin) <= 1 && typeof value.arm === 'boolean'
}
function validPenaltyShot(value: Record<string, unknown>): boolean {
  const keeper = value.keeper
  const shot = value.shot
  if (!isRecord(keeper) || !isRecord(shot)) return false
  const direction = shot.direction
  return value.type === 'penalty-shot' && safeRoomCode(value.room)
    && Number.isSafeInteger(value.penaltyId) && (value.penaltyId as number) >= 1
    && (value.kicker === 0 || value.kicker === 1)
    && Number.isInteger(value.takerId) && (value.takerId as number) >= 0 && (value.takerId as number) < 10
    && Number.isInteger(value.keeperId) && (value.keeperId as number) >= 0 && (value.keeperId as number) < 10
    && isFiniteNumber(keeper.x) && Math.abs(keeper.x) < 1500 && isFiniteNumber(keeper.y) && Math.abs(keeper.y) < 900
    && isRecord(direction) && isFiniteNumber(direction.x) && isFiniteNumber(direction.y) && Math.abs(Math.hypot(direction.x, direction.y) - 1) < 0.03
    && isFiniteNumber(shot.power) && shot.power >= 0 && shot.power <= 1 && typeof shot.forfeited === 'boolean'
}
function decode(text: string): ServerMessage | null {
  if (new TextEncoder().encode(text).length > MAX_ONLINE_PACKET_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!isRecord(value) || value.build !== ONLINE_BUILD) return null
  if (validWelcome(value)) return value as unknown as Welcome
  if (value.type === 'state' && validState(value.state)) return value as unknown as StateMessage
  if (validFlick(value)) return value
  if (validPenaltyShot(value)) return value as unknown as PenaltyShotMessage
  if (value.type === 'accepted' && Number.isSafeInteger(value.actionId) && (value.actionId as number) > 0) return value as unknown as ServerMessage
  if (value.type === 'pong' && Number.isSafeInteger(value.t) && (value.t as number) >= 0) return value as unknown as ServerMessage
  if (value.type === 'error' && ['room_full', 'invalid', 'wrong_turn', 'not_ready'].includes(String(value.code)) && typeof value.message === 'string') return value as unknown as ServerMessage
  if (value.type === 'event' && safeRoomCode(value.room) && Number.isSafeInteger(value.seq) && (value.seq as number) > 0
    && ['goal', 'win'].includes(String(value.kind)) && (value.team === null || value.team === 0 || value.team === 1)
    && (value.end === undefined || value.end === 0 || value.end === 1)
    && (value.capId === undefined || value.capId === null || (Number.isInteger(value.capId) && (value.capId as number) >= 0 && (value.capId as number) < 10))
    && pair(value.score) && value.score.every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 3)) return value as unknown as ServerMessage
  return null
}

/** Owns discovery, the socket, safe reconnect, and per-tab seat credentials. */
export class OnlineClient {
  state: LinkState = 'idle'
  role: OnlineRole | null = null
  room = ''
  /** Local-only measurements; the App folds its correction sizes into the same object. */
  readonly diag = new OnlineDiagnostics()
  private socket: WebSocket | null = null
  private token = ''
  private generation = 0
  private retryMs = 500
  private retryTimer = 0
  private pingTimer = 0
  private nextActionId = Number(sessionStorage.getItem('capball.action-seq') ?? Date.now() * 1000)
  private lastEventSeq = 0
  private requestedRoom = ''
  private stopped = true
  private endpoint = ''
  private design: NetworkTeamDesign | null = null
  private surface: SurfaceId = 'park'

  constructor(private readonly hooks: OnlineHooks) {}

  async connect(room: string, join: { design?: NetworkTeamDesign; surface?: SurfaceId } = {}): Promise<void> {
    this.stop(false)
    this.stopped = false
    this.design = join.design ?? null
    this.surface = join.surface ?? 'park'
    this.requestedRoom = room.toUpperCase()
    this.token = room ? sessionStorage.getItem(`capball.room.${room.toUpperCase()}`) ?? '' : ''
    const generation = this.generation
    this.set('discovering')
    const config = await probeOnlineConfig()
    if (generation !== this.generation || this.stopped) return
    if (!config.ok) { this.set('unavailable', config.reason); return }
    this.endpoint = config.endpoint
    this.openSocket(generation)
  }

  sendFlick(args: { capId: number; dir: { x: number; y: number }; power: number; spin: number; arm: boolean }): number | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.room) return null
    const actionId = ++this.nextActionId
    sessionStorage.setItem('capball.action-seq', String(actionId))
    this.socket.send(JSON.stringify({ type: 'flick', build: ONLINE_BUILD, room: this.room, actionId, ...args }))
    return actionId
  }

  sendPenaltyCommit(penaltyId: number, commit: string): number | null {
    return this.sendPenalty({ penaltyId, stage: 'commit', commit })
  }

  sendPenaltyReveal(penaltyId: number, choice: PenaltyChoice, nonce: string): number | null {
    return this.sendPenalty({ penaltyId, stage: 'reveal', choice, nonce })
  }

  private sendPenalty(packet: { penaltyId: number; stage: 'commit'; commit: string } | { penaltyId: number; stage: 'reveal'; choice: PenaltyChoice; nonce: string }): number | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.room) return null
    const actionId = ++this.nextActionId
    sessionStorage.setItem('capball.action-seq', String(actionId))
    this.socket.send(JSON.stringify({ type: 'penalty', build: ONLINE_BUILD, room: this.room, actionId, ...packet }))
    return actionId
  }

  stop(report = true): void {
    this.stopped = true
    this.generation++
    window.clearTimeout(this.retryTimer)
    this.stopPing()
    const socket = this.socket
    this.socket = null
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'left room') }
    if (report) this.set('closed')
    this.role = null
    this.room = ''
    this.token = ''
    this.endpoint = ''
    this.lastEventSeq = 0
    this.diag.reset()
  }

  /** Latest RTT/jitter/sequence/correction/reconnect readout. Never contains player input. */
  diagnostics(): OnlineDiagnosticsView { return this.diag.read() }

  private startPing(): void {
    this.stopPing()
    const ping = () => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.room) return
      this.socket.send(JSON.stringify({ type: 'ping', build: ONLINE_BUILD, room: this.room, t: Date.now() }))
    }
    ping()
    this.pingTimer = window.setInterval(ping, 2000)
  }

  private stopPing(): void {
    window.clearInterval(this.pingTimer)
    this.pingTimer = 0
  }

  private openSocket(generation: number): void {
    if (generation !== this.generation || this.stopped || !this.endpoint) return
    try {
      const url = new URL(this.endpoint)
      this.set('connecting')
      const socket = new WebSocket(url)
      this.socket = socket
      socket.onopen = () => {
        if (generation !== this.generation) return
        this.retryMs = 500
        this.set('open')
        socket.send(JSON.stringify({ type: 'join', build: ONLINE_BUILD, profile: { id: INVITE_PROFILE.id, version: INVITE_PROFILE.version }, surface: this.surface, ...(this.design ? { design: this.design } : {}), ...(this.requestedRoom ? { room: this.requestedRoom } : {}), ...(this.token ? { token: this.token } : {}) }))
      }
      socket.onmessage = event => {
        if (generation !== this.generation || typeof event.data !== 'string') return
        const message = decode(event.data)
        if (!message) return
        if (message.type === 'pong') {
          this.diag.rttSample(Date.now() - message.t)
          return
        }
        if (message.type === 'welcome') {
          this.room = message.room; this.role = message.role; this.token = message.token
          sessionStorage.setItem(`capball.room.${message.room}`, message.token)
          this.requestedRoom = message.room
          this.diag.snapshot(message.state.seq)
          // The server identifies a ping by its room code, so start measuring once it is known.
          this.startPing()
        }
        if (message.type === 'state') {
          // Measure ordering even when a snapshot is stale; the App still only sees fresh state.
          if (this.diag.snapshot(message.state.seq) === 'stale') return
        }
        if (message.type === 'event') {
          if (message.seq <= this.lastEventSeq) return
          this.lastEventSeq = message.seq
        }
        if ('room' in message && message.room && this.room && message.room !== this.room) return
        this.hooks.message(message)
      }
      socket.onerror = () => { /* onclose owns retry and user-facing status */ }
      socket.onclose = event => {
        if (generation !== this.generation || this.stopped) return
        this.socket = null
        this.stopPing()
        this.diag.reconnect()
        this.hooks.lost(event.code)
        if (event.code === 1008 || event.code === 4001) { this.set('closed', event.reason || 'This room can no longer be resumed.'); return }
        this.set('retrying', 'Connection dropped — trying again…')
        window.clearTimeout(this.retryTimer)
        this.retryTimer = window.setTimeout(() => {
          if (generation !== this.generation || this.stopped) return
          this.retryMs = Math.min(5000, this.retryMs * 1.7)
          this.openSocket(generation)
        }, this.retryMs)
      }
    } catch { this.set('unavailable', 'Could not open the CAPBALL room connection.') }
  }

  private set(state: LinkState, detail?: string): void { this.state = state; this.diag.setLink(state); this.hooks.status(state, detail) }
}
