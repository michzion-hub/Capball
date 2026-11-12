import type { SurfaceId } from '../config/tuning'

export const ONLINE_BUILD = 'capball-online-v1'
export const MAX_ONLINE_PACKET_BYTES = 4096

export type OnlinePhase = 'waiting' | 'aim' | 'moving' | 'goal' | 'replay' | 'reset' | 'over'
export type OnlineRole = 'p1' | 'p2'
export interface NetworkBody { x: number; y: number; angle: number; vx: number; vy: number; angularVelocity: number; active: boolean }
export interface NetworkProfile { id: string; version: number; name: string }
/** Sanitised cap-crew design as it travels between the two seats. */
export interface NetworkTeamDesign {
  name: string
  primary: string
  secondary: string
  pattern: string
  numbers: string[]
  capNames: string[]
}
/** A penalty choice. Kept separate from NetworkState so it can stay private until both commits land. */
export type PenaltyChoice =
  | { kind: 'keeper'; position: { x: number; y: number } }
  | { kind: 'shot'; direction: { x: number; y: number }; power: number; forfeited?: boolean }
/**
 * Public view of an online penalty. Only commit *presence* travels before both players
 * have locked; the choices themselves never appear in a state snapshot.
 */
export interface NetworkPenalty {
  id: number
  stage: 'commit' | 'reveal'
  kicker: 0 | 1
  takerId: number
  keeperId: number
  end: 0 | 1
  committed: [boolean, boolean]
  deadline: number
}
export interface NetworkState {
  build: typeof ONLINE_BUILD
  room: string
  seq: number
  ready: boolean
  connected: [boolean, boolean]
  profile: NetworkProfile
  /** Both crews: seat one's saved design, then seat two's. */
  teams: [NetworkTeamDesign, NetworkTeamDesign]
  /** Pitch chosen by the host; the server owns it for the whole room. */
  surface: SurfaceId
  penalty: NetworkPenalty | null
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
export type PenaltyCommitMessage = { type: 'penalty'; build: typeof ONLINE_BUILD; room: string; actionId: number; penaltyId: number; stage: 'commit'; commit: string }
export type PenaltyRevealMessage = { type: 'penalty'; build: typeof ONLINE_BUILD; room: string; actionId: number; penaltyId: number; stage: 'reveal'; choice: PenaltyChoice; nonce: string }
export type PenaltyMessage = PenaltyCommitMessage | PenaltyRevealMessage
/** Server-verified shot, broadcast to both seats once both choices are locked in. */
export type PenaltyShotMessage = {
  type: 'penalty-shot'; build: typeof ONLINE_BUILD; room: string; penaltyId: number
  kicker: 0 | 1; takerId: number; keeperId: number
  keeper: { x: number; y: number }
  shot: { direction: { x: number; y: number }; power: number; forfeited: boolean }
}
export type ErrorMessage = { type: 'error'; build: typeof ONLINE_BUILD; code: 'room_full' | 'invalid' | 'wrong_turn' | 'not_ready'; message: string }
export type EventMessage = { type: 'event'; build: typeof ONLINE_BUILD; room: string; seq: number; kind: 'goal' | 'win'; team: 0 | 1 | null; ownGoal?: boolean; end?: 0 | 1; capId?: number | null; score: [number, number] }
export type ServerMessage = Welcome | StateMessage | FlickMessage | PenaltyShotMessage | ErrorMessage | EventMessage | { type: 'accepted'; build: typeof ONLINE_BUILD; actionId: number } | { type: 'pong'; build: typeof ONLINE_BUILD; t: number }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
export function safeRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{4,8}$/.test(value)
}

/**
 * Bounded, type-only check for a crew design on the wire. Content is still sanitised
 * by `sanitizeTeam` at both ends; this only guarantees the shapes and lengths.
 */
export function isNetworkTeamDesign(value: unknown): value is NetworkTeamDesign {
  if (!isRecord(value)) return false
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max
  return text(value.name, 18) && text(value.primary, 7) && text(value.secondary, 7) && text(value.pattern, 16)
    && Array.isArray(value.numbers) && value.numbers.length === 5 && value.numbers.every(v => text(v, 2))
    && Array.isArray(value.capNames) && value.capNames.length === 5 && value.capNames.every(v => text(v, 14))
}

const round4 = (value: number): number => {
  const rounded = Math.round(value * 10_000) / 10_000
  return Object.is(rounded, -0) ? 0 : rounded
}

export function isPenaltyChoice(value: unknown): value is PenaltyChoice {
  if (!isRecord(value)) return false
  if (value.kind === 'keeper') {
    const position = value.position
    return isRecord(position) && isFiniteNumber(position.x) && isFiniteNumber(position.y)
  }
  if (value.kind === 'shot') {
    const direction = value.direction
    return isRecord(direction) && isFiniteNumber(direction.x) && isFiniteNumber(direction.y)
      && isFiniteNumber(value.power) && value.power >= 0 && value.power <= 1
      && (value.forfeited === undefined || typeof value.forfeited === 'boolean')
  }
  return false
}

/**
 * Canonical commit text. Both ends build the same string, so the SHA-256 digest travels
 * without the choice and the server can later check that the reveal is unchanged.
 */
export function penaltyCommitText(penaltyId: number, team: 0 | 1, choice: PenaltyChoice, nonce: string): string {
  if (choice.kind === 'keeper') {
    return `capball-penalty|${penaltyId}|${team}|keeper|${round4(choice.position.x)}|${round4(choice.position.y)}|${nonce}`
  }
  return `capball-penalty|${penaltyId}|${team}|shot|${round4(choice.direction.x)}|${round4(choice.direction.y)}|${round4(choice.power)}|${choice.forfeited ? 1 : 0}|${nonce}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function randomNonce(bytes = 16): string {
  const data = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(data)
  return [...data].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
