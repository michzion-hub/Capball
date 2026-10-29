import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startOnlineServer } from '../server/index'
import type { ServerMessage } from '../src/net/protocol'

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

  join(room = '', token = ''): Promise<void> {
    const packet = { type: 'join', build: 'capball-online-v1', ...(room ? { room } : {}), ...(token ? { token } : {}) }
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
