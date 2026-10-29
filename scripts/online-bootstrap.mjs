import { ONLINE_BUILD } from '../src/net/protocol.ts'

function sendBootstrap(_req, res) {
  const signalingUrl = process.env.CAPBALL_WS_URL ?? ''
  const body = JSON.stringify({ version: 1, build: ONLINE_BUILD, signalingUrl })
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function publicEndpoint() {
  const value = process.env.CAPBALL_WS_URL ?? ''
  if (!value) return ''
  let url
  try { url = new URL(value) } catch { throw new Error('CAPBALL_WS_URL must be an absolute ws:// or wss:// URL ending in /ws') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.pathname !== '/ws' || url.username || url.password || url.search || url.hash
    || !(url.protocol === 'wss:' || (loopback && url.protocol === 'ws:'))) {
    throw new Error('CAPBALL_WS_URL must use WSS except on loopback, and must end in /ws without credentials or query parameters')
  }
  return value
}

export function capballOnlineBootstrap() {
  return {
    name: 'capball-online-bootstrap',
    generateBundle() {
      const body = JSON.stringify({ version: 1, build: ONLINE_BUILD, signalingUrl: publicEndpoint() })
      this.emitFile({ type: 'asset', fileName: 'multiplayer/bootstrap.json', source: body })
    },
    configureServer(server) { server.middlewares.use('/multiplayer/bootstrap.json', sendBootstrap) },
    configurePreviewServer(server) { server.middlewares.use('/multiplayer/bootstrap.json', sendBootstrap) },
  }
}
