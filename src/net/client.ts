import { ONLINE_BUILD, MAX_ONLINE_PACKET_BYTES, isFiniteNumber, isRecord, safeRoomCode } from './protocol'
import type { FlickMessage, NetworkBody, NetworkState, OnlineRole, ServerMessage, StateMessage, Welcome } from './protocol'

export type LinkState = 'idle' | 'discovering' | 'connecting' | 'open' | 'retrying' | 'unavailable' | 'closed'
export interface OnlineHooks {
  status(state: LinkState, detail?: string): void
  message(message: ServerMessage): void
  lost(code: number): void
}

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
function validState(value: unknown): value is NetworkState {
  if (!isRecord(value)) return false
  const connected = value.connected
  const score = value.score
  const possession = value.possession
  const bodies = value.bodies
  if (!pair(connected) || !pair(score) || !isRecord(possession)) return false
  const chain = possession.chain
  const powerReady = possession.powerReady
  const phase = value.phase
  if (!pair(chain) || !pair(powerReady) || !Array.isArray(bodies)) return false
  return value.build === ONLINE_BUILD && safeRoomCode(value.room) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0
    && typeof value.ready === 'boolean' && connected.every(x => typeof x === 'boolean')
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
function decode(text: string, lastStateSeq: number, lastEventSeq: number): ServerMessage | null {
  if (new TextEncoder().encode(text).length > MAX_ONLINE_PACKET_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!isRecord(value) || value.build !== ONLINE_BUILD) return null
  if (validWelcome(value)) return value as unknown as Welcome
  if (value.type === 'state' && validState(value.state) && value.state.seq > lastStateSeq) return value as unknown as StateMessage
  if (validFlick(value)) return value
  if (value.type === 'accepted' && Number.isSafeInteger(value.actionId) && (value.actionId as number) > 0) return value as unknown as ServerMessage
  if (value.type === 'pong' && Number.isSafeInteger(value.t) && (value.t as number) >= 0) return value as unknown as ServerMessage
  if (value.type === 'error' && ['room_full', 'invalid', 'wrong_turn', 'not_ready'].includes(String(value.code)) && typeof value.message === 'string') return value as unknown as ServerMessage
  if (value.type === 'event' && safeRoomCode(value.room) && Number.isSafeInteger(value.seq) && (value.seq as number) > lastEventSeq
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
  private socket: WebSocket | null = null
  private token = ''
  private generation = 0
  private retryMs = 500
  private retryTimer = 0
  private nextActionId = Number(sessionStorage.getItem('capball.action-seq') ?? Date.now() * 1000)
  private lastStateSeq = -1
  private lastEventSeq = 0
  private requestedRoom = ''
  private stopped = true
  private endpoint = ''

  constructor(private readonly hooks: OnlineHooks) {}

  async connect(room: string): Promise<void> {
    this.stop(false)
    this.stopped = false
    this.requestedRoom = room.toUpperCase()
    this.token = room ? sessionStorage.getItem(`capball.room.${room.toUpperCase()}`) ?? '' : ''
    const generation = this.generation
    this.set('discovering')
    try {
      const configUrl = new URL('multiplayer/bootstrap.json', location.href)
      configUrl.search = ''; configUrl.hash = ''
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 8000)
      const response = await fetch(configUrl, { cache: 'no-store', signal: controller.signal }).finally(() => window.clearTimeout(timeout))
      if (!response.ok || Number(response.headers.get('content-length')) > 4096) throw new Error('Online service is not configured for this build.')
      const config: unknown = await response.json()
      if (generation !== this.generation || this.stopped) return
      if (!isRecord(config) || config.version !== 1 || config.build !== ONLINE_BUILD || !validEndpoint(config.signalingUrl)) throw new Error('Online service is not configured for this build.')
      this.endpoint = config.signalingUrl
      this.openSocket(generation)
    } catch (error) {
      if (generation !== this.generation || this.stopped) return
      this.set('unavailable', error instanceof Error ? error.message : 'Online service is unavailable.')
    }
  }

  sendFlick(args: { capId: number; dir: { x: number; y: number }; power: number; spin: number; arm: boolean }): number | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.room) return null
    const actionId = ++this.nextActionId
    sessionStorage.setItem('capball.action-seq', String(actionId))
    this.socket.send(JSON.stringify({ type: 'flick', build: ONLINE_BUILD, room: this.room, actionId, ...args }))
    return actionId
  }

  stop(report = true): void {
    this.stopped = true
    this.generation++
    window.clearTimeout(this.retryTimer)
    const socket = this.socket
    this.socket = null
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'left room') }
    if (report) this.set('closed')
    this.role = null
    this.room = ''
    this.token = ''
    this.endpoint = ''
    this.lastStateSeq = -1
    this.lastEventSeq = 0
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
        socket.send(JSON.stringify({ type: 'join', build: ONLINE_BUILD, ...(this.requestedRoom ? { room: this.requestedRoom } : {}), ...(this.token ? { token: this.token } : {}) }))
      }
      socket.onmessage = event => {
        if (generation !== this.generation || typeof event.data !== 'string') return
        const message = decode(event.data, this.lastStateSeq, this.lastEventSeq)
        if (!message) return
        if (message.type === 'welcome') {
          this.room = message.room; this.role = message.role; this.token = message.token
          sessionStorage.setItem(`capball.room.${message.room}`, message.token)
          this.requestedRoom = message.room
          this.lastStateSeq = message.state.seq
        }
        if (message.type === 'state') this.lastStateSeq = message.state.seq
        if (message.type === 'event') this.lastEventSeq = message.seq
        if ('room' in message && message.room && this.room && message.room !== this.room) return
        this.hooks.message(message)
      }
      socket.onerror = () => { /* onclose owns retry and user-facing status */ }
      socket.onclose = event => {
        if (generation !== this.generation || this.stopped) return
        this.socket = null
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

  private set(state: LinkState, detail?: string): void { this.state = state; this.hooks.status(state, detail) }
}
