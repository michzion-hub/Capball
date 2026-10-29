export const ONLINE_BUILD = 'capball-online-v1'
export const MAX_ONLINE_PACKET_BYTES = 4096

export type OnlinePhase = 'waiting' | 'aim' | 'moving' | 'goal' | 'replay' | 'reset' | 'over'
export type OnlineRole = 'p1' | 'p2'
export interface NetworkBody { x: number; y: number; angle: number; vx: number; vy: number; angularVelocity: number; active: boolean }
export interface NetworkState {
  build: typeof ONLINE_BUILD
  room: string
  seq: number
  ready: boolean
  connected: [boolean, boolean]
  phase: OnlinePhase
  team: 0 | 1
  reason: string
  turn: number
  flicks: number
  score: [number, number]
  possession: { chain: [number, number]; powerReady: [boolean, boolean]; lastCap: number | null }
  armed: 0 | 1 | null
  activeCap: number | null
  bodies: NetworkBody[]
  winner: 0 | 1 | null
}
export type Welcome = { type: 'welcome'; build: typeof ONLINE_BUILD; room: string; role: OnlineRole; token: string; state: NetworkState }
export type StateMessage = { type: 'state'; build: typeof ONLINE_BUILD; state: NetworkState }
export type FlickMessage = { type: 'flick'; build: typeof ONLINE_BUILD; room: string; actionId: number; team: 0 | 1; capId: number; dir: { x: number; y: number }; power: number; spin: number; arm: boolean }
export type ErrorMessage = { type: 'error'; build: typeof ONLINE_BUILD; code: 'room_full' | 'invalid' | 'wrong_turn' | 'not_ready'; message: string }
export type EventMessage = { type: 'event'; build: typeof ONLINE_BUILD; room: string; seq: number; kind: 'goal' | 'win'; team: 0 | 1 | null; ownGoal?: boolean; end?: 0 | 1; capId?: number | null; score: [number, number] }
export type ServerMessage = Welcome | StateMessage | FlickMessage | ErrorMessage | EventMessage | { type: 'accepted'; build: typeof ONLINE_BUILD; actionId: number } | { type: 'pong'; build: typeof ONLINE_BUILD; t: number }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
export function safeRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{4,8}$/.test(value)
}
