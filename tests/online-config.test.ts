import { afterEach, describe, expect, it, vi } from 'vitest'
import { ONLINE_NOT_CONFIGURED, probeOnlineConfig } from '../src/net/client'

function stubConfig(body: unknown, init: ResponseInit = { status: 200 }): void {
  const text = JSON.stringify(body)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, {
    ...init,
    headers: { 'content-type': 'application/json', 'content-length': String(text.length), ...(init.headers ?? {}) },
  })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('online build config probe', () => {
  it('accepts a deployed TLS endpoint and reports it before any socket opens', async () => {
    vi.stubGlobal('location', { href: 'https://capball.test/' })
    stubConfig({ version: 1, build: 'capball-online-v1', signalingUrl: 'wss://rooms.capball.test/ws' })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: true, endpoint: 'wss://rooms.capball.test/ws' })
  })

  it('accepts loopback ws for local development', async () => {
    vi.stubGlobal('location', { href: 'http://127.0.0.1:3000/' })
    stubConfig({ version: 1, build: 'capball-online-v1', signalingUrl: 'ws://127.0.0.1:4801/ws' })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: true, endpoint: 'ws://127.0.0.1:4801/ws' })
  })

  it('fails closed when the build has no endpoint configured', async () => {
    vi.stubGlobal('location', { href: 'https://capball.test/' })
    stubConfig({ version: 1, build: 'capball-online-v1', signalingUrl: '' })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })
  })

  it('rejects plain ws to a public host, credentials, queries and the wrong path', async () => {
    vi.stubGlobal('location', { href: 'https://capball.test/' })
    for (const signalingUrl of [
      'ws://rooms.capball.test/ws',
      'wss://user:pass@rooms.capball.test/ws',
      'wss://rooms.capball.test/ws?token=1',
      'wss://rooms.capball.test/socket',
    ]) {
      stubConfig({ version: 1, build: 'capball-online-v1', signalingUrl })
      await expect(probeOnlineConfig(), signalingUrl).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })
    }
  })

  it('rejects a stale build or config version', async () => {
    vi.stubGlobal('location', { href: 'https://capball.test/' })
    stubConfig({ version: 1, build: 'capball-online-v0', signalingUrl: 'wss://rooms.capball.test/ws' })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })
    stubConfig({ version: 2, build: 'capball-online-v1', signalingUrl: 'wss://rooms.capball.test/ws' })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })
  })

  it('reports not configured for HTTP errors, oversized configs and network failures', async () => {
    vi.stubGlobal('location', { href: 'https://capball.test/' })
    stubConfig({ error: 'missing' }, { status: 500 })
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })

    const huge = JSON.stringify({ version: 1, build: 'capball-online-v1', signalingUrl: 'wss://rooms.capball.test/ws', pad: 'x'.repeat(5000) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } })))
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(probeOnlineConfig()).resolves.toEqual({ ok: false, reason: ONLINE_NOT_CONFIGURED })
  })
})
