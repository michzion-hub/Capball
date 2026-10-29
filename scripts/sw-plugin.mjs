// Build-time service worker: precaches every file Vite emitted so CAPBALL runs fully offline.
// Dev server never registers it (see src/pwa.ts), so HMR is unaffected.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

const SW = (version, files) => `/* CAPBALL service worker — generated at build, do not edit. */
const CACHE = 'capball-${version}'
const PRECACHE = ${JSON.stringify(files)}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('capball-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/multiplayer/bootstrap.json')) return
  if (req.mode === 'navigate') {
    // Network first for the page (fresh deploys), cached shell when offline.
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone()
        if (res.ok) caches.open(CACHE).then(c => c.put('./index.html', copy))
        return res
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))),
    )
    return
  }
  // Hashed assets, fonts, icons: cache first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)) }
      return res
    })),
  )
})
`

export function capballServiceWorker() {
  let outDir = 'dist'
  return {
    name: 'capball-service-worker',
    apply: 'build',
    configResolved(cfg) { outDir = path.resolve(cfg.root, cfg.build.outDir) },
    closeBundle() {
      const files = walk(outDir).filter(f => f !== 'sw.js' && !f.endsWith('.map') && !f.startsWith('__manus') && !f.endsWith('.txt'))
      const hash = createHash('sha256')
      for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(outDir, f)))
      const version = hash.digest('hex').slice(0, 12)
      const list = ['./', ...files.map(f => `./${f}`)]
      fs.writeFileSync(path.join(outDir, 'sw.js'), SW(version, list))
    },
  }
}
