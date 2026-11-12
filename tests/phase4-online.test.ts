import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startOnlineServer } from '../server/index'
import { penaltyCommitText, sha256Hex } from '../src/net/protocol'
import type { NetworkState, ServerMessage } from '../src/net/protocol'
import { PITCH } from '../src/config/tuning'
import { defaultTeam } from '../src/store/settings'

class Peer {
  readonly socket: WebSocket
  private backlog: ServerMessage[] = []
  private waiters: Array<{ test: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  constructor(url: string) {
    this.socket = new WebSocket(url, { headers: { Origin: 'https://capball.test' } })
    this.socket.on('message', data => {
      let message: ServerMessage
      try { message = JSON.parse(data.toString()) as ServerMessage } catch { return }
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i]
        if (!waiter.test(message)) continue
        this.waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
      this.backlog.push(message)
      if (this.backlog.length > 100) this.backlog.shift()
    })
  }

  next(test: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const index = this.backlog.findIndex(test)
    if (index >= 0) return Promise.resolve(this.backlog.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        reject(new Error('Timed out waiting for CAPBALL room packet'))
      }, timeoutMs) }
      this.waiters.push(waiter)
    })
  }

  join(room = '', token = '', profile?: unknown, design?: unknown, surface?: unknown): Promise<void> {
    const packet = { type: 'join', build: 'capball-online-v1', ...(surface !== undefined ? { surface } : {}), ...(profile ? { profile } : {}), ...(design ? { design } : {}), ...(room ? { room } : {}), ...(token ? { token } : {}) }
    return new Promise(resolve => {
      const send = () => { this.socket.send(JSON.stringify(packet)); resolve() }
      if (this.socket.readyState === WebSocket.OPEN) send()
      else this.socket.once('open', send)
    })
  }

  send(packet: unknown): void { this.socket.send(JSON.stringify(packet)) }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve() }, 1000)
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'test complete')
    })
  }
}

const isWelcome = (m: ServerMessage) => m.type === 'welcome'
const stateWhere = (phase?: string, ready?: boolean) => (m: ServerMessage) => m.type === 'state' && (phase === undefined || m.state.phase === phase) && (ready === undefined || m.state.ready === ready)

describe('CAPBALL authoritative online rooms', () => {
  let server: Awaited<ReturnType<typeof startOnlineServer>> | null = null
  const peers: Peer[] = []
  afterEach(async () => {
    await Promise.all(peers.splice(0).map(peer => peer.close()))
    if (server) { await server.close(); server = null }
  })

  it('creates a private two-seat room, accepts only the active team, syncs physics, pauses, and resumes', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const first = new Peer(server.url); peers.push(first); await first.join()
    const w1 = await first.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w1.role).toBe('p1')
    expect(w1.state.phase).toBe('waiting')
    expect(w1.state.profile).toEqual({ id: 'proper-invite', version: 1, name: 'Proper Football · Invite' })

    const second = new Peer(server.url); peers.push(second); await second.join(w1.room)
    const w2 = await second.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w2.role).toBe('p2')
    expect(w2.state.ready).toBe(true)
    expect(w2.state.phase).toBe('aim')
    const firstReady = await first.next(stateWhere('aim', true)) as Extract<ServerMessage, { type: 'state' }>
    expect(firstReady.state.connected).toEqual([true, true])

    const base = { build: w1.build, room: w1.room, type: 'flick', actionId: 10001, dir: { x: 1, y: 0 }, power: 0.4, spin: 0, arm: false }
    first.send({ ...base, capId: 9 }) // seat one cannot flick an opponent's cap
    const rejected = await first.next(m => m.type === 'error' && m.code === 'wrong_turn')
    expect(rejected.type).toBe('error')

    first.send({ ...base, capId: 4 })
    const accepted = await first.next(m => m.type === 'accepted' && m.actionId === base.actionId)
    expect(accepted.type).toBe('accepted')
    const echo = await second.next(m => m.type === 'flick' && m.actionId === base.actionId) as Extract<ServerMessage, { type: 'flick' }>
    expect(echo.team).toBe(0)
    const movingA = await first.next(stateWhere('moving', true)) as Extract<ServerMessage, { type: 'state' }>
    const movingB = await second.next(stateWhere('moving', true)) as Extract<ServerMessage, { type: 'state' }>
    expect(movingA.state.team).toBe(0)
    expect(movingB.state.bodies[4].x).toBeCloseTo(movingA.state.bodies[4].x, 1)
    expect(movingA.state.bodies).toHaveLength(11)

    await second.close()
    const paused = await first.next(stateWhere(undefined, false)) as Extract<ServerMessage, { type: 'state' }>
    expect(paused.state.connected).toEqual([true, false])

    const resumed = new Peer(server.url); peers.push(resumed); await resumed.join(w1.room, w2.token)
    expect(resumed.socket.url).not.toContain(w2.token)
    const w2Again = await resumed.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w2Again.role).toBe('p2')
    expect(w2Again.room).toBe(w1.room)
    expect(w2Again.state.ready).toBe(true)
    const readyAgain = await first.next(stateWhere(undefined, true)) as Extract<ServerMessage, { type: 'state' }>
    expect(readyAgain.state.connected).toEqual([true, true])
  }, 30000)

  it('isolates independently created rooms', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const a = new Peer(server.url); peers.push(a); await a.join()
    const b = new Peer(server.url); peers.push(b); await b.join()
    const [wa, wb] = await Promise.all([a.next(isWelcome), b.next(isWelcome)]) as [Extract<ServerMessage, { type: 'welcome' }>, Extract<ServerMessage, { type: 'welcome' }>]
    expect(wa.room).not.toBe(wb.room)
    expect(server.roomCount()).toBe(2)
  }, 15000)

  it('answers a client ping with the same timestamp for round-trip measurement', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const peer = new Peer(server.url); peers.push(peer); await peer.join()
    const welcome = await peer.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    peer.send({ type: 'ping', build: 'capball-online-v1', room: welcome.room, t: 123456 })
    const pong = await peer.next(m => m.type === 'pong') as Extract<ServerMessage, { type: 'pong' }>
    expect(pong.t).toBe(123456)
    expect(pong.build).toBe('capball-online-v1')
  }, 15000)

  it('carries both saved crew designs and sanitises untrusted fields', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const fallback = defaultTeam(0)
    const firstDesign = {
      name: 'Gutter Kings Extra Long Name',
      primary: 'red',
      secondary: '#0f2a1a',
      pattern: 'zigzag',
      numbers: ['1', '22', 'x', '7', '9'],
      capNames: ['Big Sal', 'Brick', 'Wardrobe', 'Greasy Joe', 'Rocket Man Long'],
      extra: 'ignored',
    }
    const first = new Peer(server.url); peers.push(first)
    await first.join('', '', undefined, firstDesign)
    const w1 = await first.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    const d0 = w1.state.teams[0]
    expect(d0.name).toBe('Gutter Kings Extra')
    expect(d0.primary).toBe(fallback.primary)
    expect(d0.pattern).toBe(fallback.pattern)
    expect(d0.numbers).toEqual(['1', '22', 'x', '7', '9'])
    expect(d0.capNames[4]).toBe('Rocket Man Lon')
    expect('extra' in d0).toBe(false)
    expect(w1.state.teams[1]).toEqual(defaultTeam(1))

    const secondDesign = {
      name: 'Rooftop Rats', primary: '#1e9bff', secondary: '#0b1b2a', pattern: 'hoops',
      numbers: ['1', '2', '3', '8', '10'], capNames: ['Mitts', 'The Fridge', 'Tank', 'Slick Rick', 'Boom'],
    }
    const second = new Peer(server.url); peers.push(second)
    await second.join(w1.room, '', undefined, secondDesign)
    const w2 = await second.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w2.state.teams[0]).toEqual(d0)
    expect(w2.state.teams[1]).toEqual(secondDesign)

    const synced = await first.next(m => m.type === 'state' && m.state.ready && m.state.teams[1].name === 'Rooftop Rats') as Extract<ServerMessage, { type: 'state' }>
    expect(synced.state.teams[1]).toEqual(secondDesign)

    await second.close()
    const resumed = new Peer(server.url); peers.push(resumed)
    await resumed.join(w1.room, w2.token, undefined, { ...secondDesign, name: 'Changed Crew' })
    const again = await resumed.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(again.state.teams[1].name).toBe('Rooftop Rats')
  }, 20000)

  it('keeps the host pitch authoritative for the whole room', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const first = new Peer(server.url); peers.push(first)
    await first.join('', '', undefined, undefined, 'carpark')
    const w1 = await first.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w1.state.surface).toBe('carpark')
    const room = server.room(w1.room)
    if (!room) throw new Error('room lookup failed')
    expect(room.match.world.surface.id).toBe('carpark')

    const second = new Peer(server.url); peers.push(second)
    await second.join(w1.room, '', undefined, undefined, 'dusty')
    const w2 = await second.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w2.state.surface).toBe('carpark')
    expect(room.match.world.surface.id).toBe('carpark')

    const synced = await first.next(m => m.type === 'state' && m.state.ready) as Extract<ServerMessage, { type: 'state' }>
    expect(synced.state.surface).toBe('carpark')
  }, 20000)

  it('falls back to the park when a host sends an unknown pitch', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const first = new Peer(server.url); peers.push(first)
    await first.join('', '', undefined, undefined, 'moon')
    const w1 = await first.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    expect(w1.state.surface).toBe('park')
    expect(server.room(w1.room)?.match.world.surface.id).toBe('park')
  }, 20000)

  it('runs a server-verified commit-and-reveal hidden penalty without leaking choices', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const first = new Peer(server.url); peers.push(first); await first.join()
    const w1 = await first.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    const second = new Peer(server.url); peers.push(second); await second.join(w1.room)
    await second.next(isWelcome)
    await first.next(stateWhere('aim', true), 10000)
    const room = server.room(w1.room)
    if (!room) throw new Error('room lookup failed')
    if (!room.match.awardInputFoul({ x: 10, y: PITCH.height / 2 })) throw new Error('could not force a penalty-area foul')

    const penaltyState = await first.next(m => m.type === 'state' && m.state.penalty !== null, 10000) as Extract<ServerMessage, { type: 'state' }>
    const flow = penaltyState.state.penalty!
    expect(flow.stage).toBe('commit')
    expect(flow.kicker).toBe(1)
    expect(flow.end).toBe(0)
    expect(Object.keys(flow).sort()).toEqual(['committed', 'deadline', 'end', 'id', 'keeperId', 'kicker', 'stage', 'takerId'])

    const keeperChoice = { kind: 'keeper' as const, position: { x: 1, y: PITCH.height / 2 - 40 } }
    const shotChoice = { kind: 'shot' as const, direction: { x: -1, y: 0 }, power: 0.7 }
    const keeperNonce = 'a'.repeat(32)
    const shotNonce = 'b'.repeat(32)
    const keeperCommit = await sha256Hex(penaltyCommitText(flow.id, 0, keeperChoice, keeperNonce))
    const shotCommit = await sha256Hex(penaltyCommitText(flow.id, 1, shotChoice, shotNonce))
    const packet = (actionId: number, extra: Record<string, unknown>) => ({ type: 'penalty', build: 'capball-online-v1', room: w1.room, actionId, penaltyId: flow.id, ...extra })

    first.send(packet(1, { stage: 'commit', commit: keeperCommit }))
    const locked = await first.next(m => m.type === 'state' && m.state.penalty?.committed[0] === true && m.state.penalty?.committed[1] === false, 5000) as Extract<ServerMessage, { type: 'state' }>
    const wire = JSON.stringify(locked)
    expect(wire).not.toContain('position')
    expect(wire).not.toContain('direction')
    expect(wire).not.toContain(keeperNonce)
    expect(wire).not.toContain(keeperCommit)
    expect(locked.state.penalty?.stage).toBe('commit')

    second.send(packet(1, { stage: 'commit', commit: shotCommit }))
    const reveal = await first.next(m => m.type === 'state' && m.state.penalty?.stage === 'reveal', 5000) as Extract<ServerMessage, { type: 'state' }>
    expect(reveal.state.penalty?.committed).toEqual([true, true])
    expect(JSON.stringify(reveal)).not.toContain(shotNonce)

    first.send(packet(2, { stage: 'reveal', choice: keeperChoice, nonce: keeperNonce }))
    second.send(packet(2, { stage: 'reveal', choice: shotChoice, nonce: shotNonce }))
    const shot = await first.next(m => m.type === 'penalty-shot', 5000) as Extract<ServerMessage, { type: 'penalty-shot' }>
    const shotForSecond = await second.next(m => m.type === 'penalty-shot', 5000) as Extract<ServerMessage, { type: 'penalty-shot' }>
    expect(shot).toEqual(shotForSecond)
    expect(shot.kicker).toBe(1)
    expect(shot.shot).toEqual({ direction: { x: -1, y: 0 }, power: 0.7, forfeited: false })
    expect(shot.keeper.y).toBeCloseTo(PITCH.height / 2 - 40, 0)
    expect(shot.keeper.x).toBeLessThan(40)

    const moving = await first.next(m => m.type === 'state' && m.state.penalty === null && m.state.phase === 'moving', 5000) as Extract<ServerMessage, { type: 'state' }>
    expect((moving.state as NetworkState).penalty).toBeNull()
    expect(room.match.takerId).toBe(shot.takerId)
  }, 20000)

  it('rejects an online rules profile outside the server allowlist', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const bad = new Peer(server.url); peers.push(bad); await bad.join('', '', { id: 'proper-invite', version: 999 })
    const error = await bad.next(m => m.type === 'error') as Extract<ServerMessage, { type: 'error' }>
    expect(error.code).toBe('invalid')
    expect(error.message).toMatch(/rules profile/i)
    expect(server.roomCount()).toBe(0)
  }, 15000)

  it('rejects missing origins and disconnects packet floods', async () => {
    server = await startOnlineServer({ host: '127.0.0.1', port: 0, allowedOrigins: ['https://capball.test'] })
    const untrusted = new WebSocket(server.url)
    const status = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('origin check did not complete')), 3000)
      untrusted.once('unexpected-response', (_request, response) => { clearTimeout(timer); resolve(response.statusCode ?? 0) })
      untrusted.once('open', () => { clearTimeout(timer); reject(new Error('server accepted a WebSocket without an Origin')) })
      untrusted.once('error', () => {})
    })
    expect(status).toBe(403)
    untrusted.terminate()

    const peer = new Peer(server.url); peers.push(peer); await peer.join()
    const welcome = await peer.next(isWelcome) as Extract<ServerMessage, { type: 'welcome' }>
    const closed = new Promise<number>(resolve => peer.socket.once('close', code => resolve(code)))
    for (let t = 0; t < 25; t++) peer.send({ type: 'ping', build: welcome.build, room: welcome.room, t })
    expect(await closed).toBe(1008)
  }, 10000)
})
