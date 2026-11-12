// End-to-end smoke test: dist/ must already exist (`npm run build`).
// Serves dist/, plays real mouse and touch flicks in headless Chromium, walks the menus,
// fails on any console/page/network error, and writes screenshots to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import { WebSocket, WebSocketServer } from 'ws'

/** Ask the OS for a port that is actually bindable right now (Windows excludes whole ranges for NAT). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const port = await freePort()
let onlinePort = await freePort()
while (onlinePort === port) onlinePort = await freePort()
const url = `http://127.0.0.1:${port}/`
const onlineUrl = `ws://127.0.0.1:${onlinePort}/ws`
const allowedOrigin = `http://127.0.0.1:${port}`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
let roomErr = ''
let previewErr = ''
const roomServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(onlinePort), CAPBALL_ALLOWED_ORIGINS: allowedOrigin } })
roomServer.stderr?.on('data', chunk => { roomErr = (roomErr + chunk).slice(-2000) })
// Deterministic delay/jitter proxy between the browsers and the authoritative room server, so the
// online flow is exercised under a non-localhost link. Server->client is delayed 25/70 ms in turn.
const proxyPort = await freePort()
const upstreams = new Set()
let proxySeq = 0
const proxy = new WebSocketServer({ host: '127.0.0.1', port: proxyPort, path: '/ws', perMessageDeflate: false })
proxy.on('connection', client => {
  const upstream = new WebSocket(onlineUrl, { headers: { Origin: allowedOrigin }, perMessageDeflate: false })
  upstreams.add(upstream)
  const queued = []
  const flush = () => { for (const text of queued.splice(0)) if (upstream.readyState === WebSocket.OPEN) upstream.send(text) }
  upstream.on('open', flush)
  upstream.on('message', data => {
    const delay = (proxySeq++ % 2 === 0) ? 25 : 70
    setTimeout(() => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()) }, delay)
  })
  upstream.on('close', () => { upstreams.delete(upstream); if (client.readyState < WebSocket.CLOSING) client.close() })
  upstream.on('error', () => { try { client.close() } catch {} })
  client.on('message', data => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString())
    else queued.push(data.toString())
  })
  client.on('close', () => { upstreams.delete(upstream); if (upstream.readyState < WebSocket.CLOSING) upstream.close() })
})
const clientUrl = `ws://127.0.0.1:${proxyPort}/ws`
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CAPBALL_WS_URL: clientUrl } })
server.stderr?.on('data', chunk => { previewErr = (previewErr + chunk).slice(-2000) })
let browser
const guard = setTimeout(() => fail('timed out'), 480_000)
function cleanup() { clearTimeout(guard); try { server.kill('SIGTERM'); roomServer.kill('SIGTERM') } catch {} for (const ws of upstreams) { try { ws.terminate() } catch {} } try { proxy.close() } catch {} }
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`preview server did not start on ${port}${previewErr ? `: ${previewErr.trim()}` : ''}`)
}
async function waitForRoomServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${onlinePort}/healthz`)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`CAPBALL online server did not start on ${onlinePort}${roomErr ? `: ${roomErr.trim()}` : ''}`)
}
const errors = []
async function open(context, href = url) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(`${m.text()} @ ${m.location().url}:${m.location().lineNumber}`))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('requestfailed', r => errors.push(`request failed ${r.url()} (${r.failure()?.errorText ?? 'unknown'})`))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(href)
  await page.waitForSelector('[data-screen="start"].is-active', { timeout: 30_000 })
  await page.waitForFunction(() => !document.getElementById('boot'))
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px Bangers'),
      document.fonts.load('400 16px "Permanent Marker"'),
      document.fonts.load('400 16px ManusCC0'),
      document.fonts.load('700 16px ManusCC0'),
    ])
    await document.fonts.ready
  })
  return page
}
const state = page => page.evaluate(() => {
  const m = window.__capball.match
  return { phase: m.phase, team: m.team, goals: m.score.goals, screen: document.querySelector('#ui').dataset.current }
})
const capScreen = (page, id) => page.evaluate(i => {
  const a = window.__capball
  return a.renderer.view.toScreen(a.match.world.caps[i].position)
}, id)
function diagnosticWait(page, pred, ms, kind) {
  const caller = new Error().stack?.split('\n')[3]?.trim() ?? 'unknown caller'
  const condition = String(pred).replace(/\s+/g, ' ').slice(0, 180)
  return page.waitForFunction(pred, null, { timeout: ms, polling: 50 }).catch(error => {
    throw new Error(`${kind} failed at ${caller} (${condition}): ${error.message}`)
  })
}
const waitPhase = (page, pred, ms = 15000) => diagnosticWait(page, pred, ms, 'phase wait')
const waitForFunction = (page, pred, ms = 15000) => diagnosticWait(page, pred, ms, 'browser condition')
/** Start a mode from the start screen; confirms the setup sheet when one exists. */
async function startMode(page, action, tap = false) {
  const press = sel => (tap ? page.tap(sel) : page.click(sel))
  await press(`[data-action="${action}"]`)
  if (action === 'mode:quick' && await page.$('[data-modal="tutorial-prompt"].is-active')) await press('[data-action="tutorial:skip-prompt"]')
  if (await page.$('[data-screen="setup"].is-active')) await press('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await autoDismissRuleHints(page)
  await page.waitForTimeout(250)
}

async function autoDismissRuleHints(page) {
  await page.evaluate(() => {
    const modal = document.querySelector('[data-modal="rule-hint"]')
    if (!modal || modal.dataset.smokeDismissInstalled) return
    modal.dataset.smokeDismissInstalled = 'true'
    const dismiss = () => {
      if (!modal.classList.contains('is-active')) return
      modal.querySelector('[data-action="rulehint:close"]')?.click()
    }
    const observer = new MutationObserver(dismiss)
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] })
    window.__ruleHintSmokeObserver = observer
  })
}

async function clickPauseAction(page, action) {
  const pause = page.locator('[data-modal="pause"].is-active')
  if (!(await pause.count())) {
    await page.click('.hud-tools [data-action="pause"]')
    await page.waitForSelector('[data-modal="pause"].is-active')
  }
  const control = page.locator(`[data-modal="pause"].is-active [data-action="${action}"]`)
  if (!(await control.isVisible())) throw new Error(`pause action is not visible: ${action}`)
  await control.click()
}

async function assertHudPause(page, label) {
  const viewport = page.viewportSize()
  const hudActions = await page.locator('.hud-tools button').evaluateAll(els => els.filter(el => !el.hidden).map(el => el.textContent.trim()))
  if (hudActions.length !== 1 || hudActions[0] !== 'Pause') throw new Error(`${label}: live HUD should expose only Pause, got ${hudActions}`)
  const capId = await page.evaluate(() => window.__capball.pickable()[0]?.id)
  if (capId === undefined) throw new Error(`${label}: no cap available for the flick-power readout check`)
  const cap = await capScreen(page, capId)
  await page.mouse.move(cap.x, cap.y)
  await page.mouse.down()
  await page.mouse.move(cap.x - 5, cap.y)
  const pull = await page.locator('[data-aim-power]').evaluate(el => ({ hidden: el.hidden, level: el.dataset.level, value: el.querySelector('[role="meter"]').getAttribute('aria-valuenow') }))
  if (pull.hidden || pull.level !== 'pull' || Number(pull.value) !== 0) throw new Error(`${label}: low-pull feedback missing or changed power mapping: ${JSON.stringify(pull)}`)
  await page.mouse.up()
  if (!(await page.locator('[data-aim-power]').evaluate(el => el.hidden))) throw new Error(`${label}: aim readout stayed visible after release`)

  await page.click('.hud-tools [data-action="pause"]')
  await page.waitForSelector('[data-modal="pause"].is-active')
  const sheet = await page.locator('[data-modal="pause"].is-active .pause-sheet').evaluate(el => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: r.height, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
  })
  if (sheet.top < -1 || sheet.bottom > viewport.height + 1 || sheet.scrollHeight > sheet.clientHeight + 1) throw new Error(`${label}: pause sheet overflows or needs scrolling: ${JSON.stringify({ viewport, sheet })}`)
  const actions = await page.locator('[data-modal="pause"].is-active .pause-sheet button:not([hidden])').evaluateAll(els => els.map(el => ({ label: el.textContent.trim(), height: el.getBoundingClientRect().height })))
  if (actions.some(action => action.height < 44)) throw new Error(`${label}: pause sheet has a touch target below 44px: ${JSON.stringify(actions)}`)
  for (const expected of ['Resume match', 'Restart', 'Rules', 'Sound on', 'New match', 'Concede match']) {
    if (!actions.some(action => action.label === expected)) throw new Error(`${label}: pause sheet is missing ${expected}: ${JSON.stringify(actions)}`)
  }
  if (actions.some(action => action.label === 'Tuning tools')) throw new Error(`${label}: developer Tuning Tools leaked into a normal-player pause sheet`)

  await page.locator('[data-modal="pause"] [data-action="rules"]').click()
  await page.waitForSelector('[data-modal="rules"].is-active')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-modal="pause"].is-active')
  if (await page.evaluate(() => document.activeElement?.dataset.action) !== 'rules') throw new Error(`${label}: closing Rules did not return focus to the pause sheet`)
  await clickPauseAction(page, 'sound')
  if (await page.locator('[data-modal="pause"] [data-action="sound"]').getAttribute('aria-pressed') !== 'false') throw new Error(`${label}: Sound Off state did not update`)
  await clickPauseAction(page, 'sound')
  if (await page.locator('[data-modal="pause"] [data-action="sound"]').getAttribute('aria-pressed') !== 'true') throw new Error(`${label}: Sound On state did not update`)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-modal="pause"].is-active'))
  const pauseClosed = await page.locator('[data-modal="pause"]').evaluate(el => !el.classList.contains('is-active'))
  if (!pauseClosed || await page.evaluate(() => document.activeElement?.dataset.action) !== 'pause') throw new Error(`${label}: Escape did not resume and restore focus to Pause`)
}

async function firstRunTutorial(page) {
  await page.click('[data-action="mode:quick"]')
  await page.waitForSelector('[data-modal="tutorial-prompt"].is-active')
  await page.screenshot({ path: `${out}/11-tutorial-prompt.png` })
  await page.click('[data-action="tutorial:learn"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.waitForSelector('[data-tutorial-coach]:not([hidden])')
  await page.evaluate(() => {
    window.__tutorialFlickPowers = []
    window.__capball.match.events.on('flick', event => window.__tutorialFlickPowers.push(event.power))
  })
  const flickWith = async (dx, dy = 0) => {
    const before = await page.evaluate(() => window.__tutorialFlickPowers.length)
    const id = await page.evaluate(() => window.__capball.pickable()[0]?.id ?? 4)
    await mouseFlick(page, id, dx, dy)
    await page.waitForFunction(n => window.__tutorialFlickPowers.length > n, before, { timeout: 5000, polling: 50 })
    return page.evaluate(() => window.__tutorialFlickPowers.at(-1))
  }
  await flickWith(-52)
  await page.waitForFunction(() => window.__capball.mode === 'tutorial' && window.__capball.match.phase === 'aim' && window.__capball.match.team === 0 && window.__capball.tutorialGuide.step === 1, null, { timeout: 20000, polling: 50 })
  const shortPower = await flickWith(-48)
  await page.waitForFunction(() => window.__capball.mode === 'tutorial' && window.__capball.match.phase === 'aim' && window.__capball.match.team === 0, null, { timeout: 20000, polling: 50 })
  if (shortPower >= 0.4) throw new Error(`tutorial short pull was not short: power=${shortPower}`)
  if (await page.evaluate(() => window.__capball.tutorialGuide.snapshot().shortPullSeen) !== true) throw new Error('tutorial did not record the real short pull')
  const longPower = await flickWith(-132)
  await page.waitForFunction(() => window.__capball.mode === 'tutorial' && window.__capball.match.phase === 'aim' && window.__capball.match.team === 0 && window.__capball.tutorialGuide.step === 2, null, { timeout: 20000, polling: 50 })
  if (longPower < 0.4) throw new Error(`tutorial long pull was not powerful enough to advance: power=${longPower}`)
  await page.screenshot({ path: `${out}/11-tutorial-settle.png` })
  await flickWith(-78, 12)
  await page.waitForFunction(() => window.__capball.mode === 'tutorial' && window.__capball.match.phase === 'aim' && window.__capball.match.team === 0 && window.__capball.tutorialGuide.step === 3, null, { timeout: 20000, polling: 50 })
  await page.click('[data-action="tutorial:pause"]')
  await page.waitForSelector('[data-modal="pause"].is-active')
  await page.click('[data-action="tutorial:leave"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  if (await page.evaluate(() => window.__capball.settings.tutorialStep) !== 3) throw new Error('tutorial lesson progress was not saved on leave')
  await page.reload()
  await page.waitForSelector('[data-screen="start"].is-active')
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'dark') throw new Error('dark mode did not survive a reload')
  await page.locator('.start-more summary').click()
  if (!(await page.locator('[data-action="tutorial:entry"]').innerText()).includes('Resume tutorial')) throw new Error('saved tutorial did not offer resume after reload')
  await page.click('[data-action="tutorial:entry"]')
  await page.waitForFunction(() => window.__capball.mode === 'tutorial' && window.__capball.tutorialGuide.step === 3 && window.__capball.match.phase === 'aim')
  for (const step of [4, 5, 6, 7]) {
    await page.click('[data-action="tutorial:skip"]')
    await page.waitForFunction(n => window.__capball.tutorialGuide.step === n, step)
  }
  await page.waitForSelector('[data-modal="tutorial-done"].is-active')
  await page.screenshot({ path: `${out}/11-tutorial-complete.png` })
  await page.click('[data-action="tutorial:regular"]')
  await page.waitForSelector('[data-screen="setup"].is-active')
  await page.click('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  const darkHud = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    renderer: window.__capball.renderer.isDark,
    meter: getComputedStyle(document.querySelector('.meter')).backgroundColor,
    slip: getComputedStyle(document.querySelector('.slip')).backgroundColor,
  }))
  if (darkHud.theme !== 'dark' || !darkHud.renderer || darkHud.meter === 'rgba(243, 238, 226, 0.92)') throw new Error(`HUD did not stay dark after the tutorial: ${JSON.stringify(darkHud)}`)
}
/** Dark mode must be a real theme, not a tint: tokens invert, text stays readable, crews stay distinct. */
async function assertDarkTheme(page, label, shot) {
  const t = await page.evaluate(() => {
    const rgb = value => {
      const v = value.trim()
      if (v.startsWith('#')) {
        const n = parseInt(v.slice(1), 16)
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      }
      const m = v.match(/rgba?\(([^)]+)\)/)
      return m ? m[1].split(',').slice(0, 3).map(Number) : [0, 0, 0]
    }
    const lum = color => {
      const [r, g, b] = rgb(color).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) }
    // Same weighted distance the crew editor uses to decide two kits clash.
    const distance = (a, b) => {
      const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b)
      const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2
      return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
    }
    const root = getComputedStyle(document.documentElement)
    const ink = root.getPropertyValue('--ink'), paper = root.getPropertyValue('--paper')
    const card = getComputedStyle(document.querySelector('.start-wrap')).backgroundColor
    const tagline = getComputedStyle(document.querySelector('.tagline')).color
    const teams = window.__capball.settings.teams
    return {
      theme: document.documentElement.dataset.theme,
      setting: window.__capball.settings.dark,
      renderer: window.__capball.renderer.isDark,
      inkPaper: contrast(ink, paper),
      taglinePaper: contrast(tagline, paper),
      paperLum: lum(paper),
      cardMatchesPaper: rgb(card).join() === rgb(paper).join(),
      crewDistance: distance(teams[0].primary, teams[1].primary),
      crewOnCard: Math.min(contrast(teams[0].primary, paper), contrast(teams[1].primary, paper)),
      stored: (() => { try { return JSON.parse(localStorage.getItem('capball.v1') || '{}').dark } catch { return undefined } })(),
    }
  })
  if (t.theme !== 'dark' || t.setting !== true || t.renderer !== true) throw new Error(`${label}: dark theme did not apply: ${JSON.stringify(t)}`)
  if (t.paperLum > 0.06 || !t.cardMatchesPaper) throw new Error(`${label}: dark paper token did not repaint surfaces: ${JSON.stringify(t)}`)
  if (t.inkPaper < 7 || t.taglinePaper < 4.5) throw new Error(`${label}: dark text contrast is too low: ${JSON.stringify(t)}`)
  if (t.crewDistance < 110 || t.crewOnCard < 1.8) throw new Error(`${label}: crews are not distinguishable in dark mode: ${JSON.stringify(t)}`)
  if (t.stored !== true) throw new Error(`${label}: dark mode was not persisted: ${JSON.stringify(t)}`)
  if (shot) await page.screenshot({ path: `${out}/${shot}` })
  return t
}

async function mouseFlick(page, id, dx, dy) {
  const c = await capScreen(page, id)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 5 })
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 5 })
  await page.mouse.up()
}
/** Clear the pitch and set up a shot for `team` (real physics does the rest). */
async function lineUpShot(page, team) {
  await page.evaluate(t => {
    const w = window.__capball.match.world
    w.caps.forEach((b, i) => w.place(b, { x: 500, y: 25 + i * 60 }))
    w.place(w.ball, { x: t === 0 ? 930 : 70, y: 310 })
    w.place(w.caps[t === 0 ? 4 : 9], { x: t === 0 ? 860 : 140, y: 310 })
  }, team)
}
async function finishPlay(page) {
  await waitPhase(page, () => ['goal', 'replay', 'reset', 'aim', 'over'].includes(window.__capball.match.phase) && window.__capball.match.phase !== 'moving')
  await page.evaluate(() => window.__capball.skipReplay?.())
  await waitPhase(page, () => ['aim', 'over'].includes(window.__capball.match.phase), 20000)
}

async function assertStartMenu(page, label) {
  await page.evaluate(() => document.fonts.ready)
  const m = await page.evaluate(() => {
    const screen = document.querySelector('[data-screen="start"]')
    const card = document.querySelector('.start-wrap')
    const buttons = [...document.querySelectorAll('[data-main-mode]')]
    const rect = card.getBoundingClientRect()
    return {
      labels: buttons.map(b => b.innerText.replace(/\s+/g, ' ').trim()),
      widths: buttons.map(b => b.offsetWidth),
      heights: buttons.map(b => b.offsetHeight),
      cardTop: rect.top,
      cardBottom: rect.bottom,
      viewportHeight: window.innerHeight,
      scrollOverflow: screen.scrollHeight - screen.clientHeight,
      capIcon: !!document.querySelector('[data-main-mode="design"] .menu-cap-icon'),
      menuHasSoundChip: !!document.querySelector('[data-screen="start"] .start-menu [data-action="sound"]'),
      invite: (() => {
        const b = document.querySelector('[data-invite-entry]')
        return b ? {
          height: b.offsetHeight,
          visible: b.getClientRects().length > 0,
          inMain: !!document.querySelector('.start-main-actions [data-invite-entry]'),
          inMore: !!document.querySelector('.start-more [data-invite-entry]'),
        } : null
      })(),
    }
  })
  const expected = ['Quick Match', 'Design Your Caps', 'Penalty Shootout', 'Street Tournament']
  if (JSON.stringify(m.labels) !== JSON.stringify(expected)) throw new Error(`${label} main menu order mismatch: ${JSON.stringify(m.labels)}`)
  if (Math.max(...m.widths) - Math.min(...m.widths) > 1) throw new Error(`${label} main buttons have unequal widths: ${JSON.stringify(m.widths)}`)
  if (m.heights.some(h => h < 44) || m.heights[0] <= Math.max(...m.heights.slice(1))) throw new Error(`${label} button hierarchy/tap-size mismatch: ${JSON.stringify(m.heights)}`)
  if (!m.capIcon || m.menuHasSoundChip) throw new Error(`${label} cap icon or settings relocation is missing`)
  if (!m.invite || !m.invite.visible || m.invite.height < 44) throw new Error(`${label} Invite a Mate entry missing or too small: ${JSON.stringify(m.invite)}`)
  if (m.invite.inMain || m.invite.inMore) throw new Error(`${label} Invite a Mate should be a dedicated entry outside the mode group and help disclosure: ${JSON.stringify(m.invite)}`)
  if (m.cardTop < -1 || m.cardBottom > m.viewportHeight + 1 || m.scrollOverflow > 2) throw new Error(`${label} menu clips or scrolls: ${JSON.stringify(m)}`)
  return m
}

try {
  await waitForRoomServer()
  await waitForServer()
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))

  // ---------- desktop / mouse ----------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 760 } })
  const page = await open(desk)
  await page.screenshot({ path: `${out}/01-start.png` })
  await assertStartMenu(page, 'desktop')
  await page.keyboard.press('Tab')
  const firstFocus = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), outline: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth }))
  if (firstFocus.label !== 'Open settings' || firstFocus.outline === 'none' || firstFocus.width === '0px') throw new Error(`menu gear focus styling missing: ${JSON.stringify(firstFocus)}`)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-modal="settings"].is-active')
  const normalSettings = await page.evaluate(() => ({
    tuningHidden: document.querySelector('[data-setting-row="tuning"]').hidden,
    visible: [...document.querySelectorAll('[data-setting-row]:not([hidden])')].map(row => row.dataset.settingRow),
  }))
  if (!normalSettings.tuningHidden || JSON.stringify(normalSettings.visible) !== JSON.stringify(['commentary', 'speech', 'sound', 'dark'])) throw new Error(`normal settings visibility mismatch: ${JSON.stringify(normalSettings)}`)
  await page.waitForFunction(() => {
    const sheet = document.querySelector('[data-modal="settings"] .sheet')
    return !!sheet && Number(getComputedStyle(sheet).opacity) >= 0.95
  }, null, { timeout: 2500 })
  const sheetOpacity = await page.locator('[data-modal="settings"] .sheet').evaluate(el => Number(getComputedStyle(el).opacity))
  if (sheetOpacity < 0.95) throw new Error(`settings sheet did not finish appearing: opacity=${sheetOpacity}`)
  await page.screenshot({ path: `${out}/01-menu-settings.png` })
  await page.keyboard.press('Space')
  const switched = await page.locator('[data-setting-switch="commentary"]').getAttribute('aria-checked')
  const switchLabel = await page.locator('[data-setting-switch="commentary"] [data-setting-state]').innerText()
  if (switched !== 'false' || switchLabel !== 'Off') throw new Error('keyboard settings switch did not expose its Off state')
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'light') throw new Error('light theme was not the default')
  await page.locator('[data-setting-switch="dark"]').focus()
  await page.keyboard.press('Space')
  const darkSwitch = await page.locator('[data-setting-switch="dark"]').evaluate(el => ({ checked: el.getAttribute('aria-checked'), label: el.querySelector('[data-setting-state]').textContent, height: el.getBoundingClientRect().height }))
  if (darkSwitch.checked !== 'true' || darkSwitch.label !== 'On' || darkSwitch.height < 44) throw new Error(`dark mode switch did not turn on cleanly: ${JSON.stringify(darkSwitch)}`)
  const darkDialog = await page.evaluate(() => {
    const sheet = getComputedStyle(document.querySelector('[data-modal="settings"] .sheet'))
    const row = getComputedStyle(document.querySelector('[data-setting-row="dark"] .setting-description'))
    return { theme: document.documentElement.dataset.theme, sheet: sheet.backgroundColor, row: row.color }
  })
  if (darkDialog.theme !== 'dark' || darkDialog.row === 'rgb(67, 62, 54)') throw new Error(`settings dialog did not repaint for dark mode: ${JSON.stringify(darkDialog)}`)
  await page.screenshot({ path: `${out}/01-menu-settings-dark.png` })
  await page.keyboard.press('Escape')
  if (!(await page.locator('[data-modal="settings"]').evaluate(el => !el.classList.contains('is-active')))) throw new Error('Escape did not close the settings dialog')
  if (await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) !== 'Open settings') throw new Error('closing settings did not restore focus to the gear')
  await assertDarkTheme(page, 'desktop menu', '01-start-dark.png')
  await firstRunTutorial(page)
  await assertHudPause(page, 'desktop')
  await page.evaluate(() => window.__capball.match.events.emit('turn', { team: 0, reason: 'goalkick' }))
  await page.waitForSelector('[data-modal="rule-hint"].is-active')
  const ruleCard = await page.locator('[data-modal="rule-hint"]').innerText()
  if (!ruleCard.includes('Goal kick') || !ruleCard.includes('penalty area') || !ruleCard.includes('keeper')) throw new Error(`goal-kick referee card is missing its restriction: ${ruleCard}`)
  await page.waitForTimeout(280)
  await page.screenshot({ path: `${out}/11-first-goalkick-hint.png` })
  await page.click('[data-action="rulehint:close"]')
  await page.evaluate(() => window.__capball.match.events.emit('turn', { team: 0, reason: 'goalkick' }))
  if (await page.locator('[data-modal="rule-hint"]').evaluate(el => el.classList.contains('is-active'))) throw new Error('goal-kick hint was shown again after dismissal')
  await autoDismissRuleHints(page)
  const counts0 = await page.evaluate(() => window.__capball.debugCounts())
  let s = await state(page)
  if (s.phase !== 'aim' || s.team !== 0) throw new Error(`bad kickoff state ${JSON.stringify(s)}`)

  // Real drag-back flick with the mouse; hold mid-drag for the aim screenshot.
  const p = await capScreen(page, 4)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x - 70, p.y + 10, { steps: 6 })
  await page.mouse.move(p.x - 130, p.y + 18, { steps: 6 })
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${out}/02-aim.png` })
  await page.mouse.up()
  s = await state(page)
  if (s.phase !== 'moving') throw new Error(`flick did not start play: ${JSON.stringify(s)}`)
  // Second flick in the same turn must be refused.
  const again = await page.evaluate(() => window.__capball.match.tryFlick(4, { x: 1, y: 0 }, 1))
  if (again) throw new Error('second flick in one turn was accepted')
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/03-moving.png` })
  await waitPhase(page, () => window.__capball.match.phase === 'aim')
  s = await state(page)
  if (s.team !== 1) throw new Error(`turn did not pass after settling: ${JSON.stringify(s)}`)
  if (!(await page.evaluate(() => window.__capball.match.world.isAtRest()))) throw new Error('turn passed while bodies still moving')

  // Minimum drag cancels.
  const q = await capScreen(page, 9)
  await page.mouse.move(q.x, q.y); await page.mouse.down(); await page.mouse.move(q.x + 4, q.y + 2, { steps: 2 }); await page.mouse.up()
  s = await state(page)
  if (s.phase !== 'aim' || s.team !== 1) throw new Error('minimum drag did not cancel')

  // Real-physics goal by team 1.
  await lineUpShot(page, 1)
  await mouseFlick(page, 9, 140, 0)
  await waitPhase(page, () => ['goal', 'replay'].includes(window.__capball.match.phase))
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/04-goal.png` })
  s = await state(page)
  if (s.goals[1] !== 1 || s.goals[0] !== 0) throw new Error(`goal not counted: ${JSON.stringify(s)}`)
  // Slow-motion replay rolls after the celebration.
  await waitPhase(page, () => window.__capball.match.phase === 'replay', 8000)
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${out}/04b-replay.png` })
  if (!(await page.isVisible('[data-replay]'))) throw new Error('replay tag not shown')
  await page.click('[data-replay]')
  await finishPlay(page)
  s = await state(page)
  if (s.goals[1] !== 1) throw new Error('goal counted more than once')
  if (s.team !== 0) throw new Error('conceding team should kick off')

  // Rules panel + sound toggle.
  await clickPauseAction(page, 'rules')
  await page.waitForSelector('[data-modal="rules"].is-active')
  await page.screenshot({ path: `${out}/05-rules.png` })
  await page.click('[data-modal="rules"] [data-action="closemodal"]')
  await clickPauseAction(page, 'sound')
  if (!(await page.evaluate(() => window.__capball.settings.sound === false))) throw new Error('sound toggle failed')
  await clickPauseAction(page, 'sound')
  await clickPauseAction(page, 'resume')

  // Play shots until someone reaches the target.
  for (let k = 0; k < 8; k++) {
    s = await state(page)
    if (s.phase === 'over') break
    await lineUpShot(page, s.team)
    await mouseFlick(page, s.team === 0 ? 4 : 9, s.team === 0 ? -140 : 140, 0)
    await finishPlay(page)
  }
  s = await state(page)
  if (s.phase !== 'over') throw new Error(`match did not end: ${JSON.stringify(s)}`)
  await page.waitForSelector('[data-modal="winner"].is-active')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/06-winner.png` })
  if (Math.max(...s.goals) !== 3) throw new Error(`winner without 3 goals: ${s.goals}`)
  const fullTime = await page.evaluate(() => ({
    mode: document.querySelector('[data-summary-mode]')?.textContent,
    score: [...document.querySelectorAll('[data-summary-score]')].map(el => el.textContent),
    rows: [...document.querySelectorAll('[data-summary-stats] tr')].map(row => row.textContent?.replace(/\s+/g, ' ').trim()),
    replay: !document.querySelector('[data-summary-replay]').hidden,
    phase: window.__capball.match.phase,
  }))
  if (fullTime.mode !== 'Quick Match' || JSON.stringify(fullTime.score) !== JSON.stringify(s.goals.map(String)) || fullTime.rows.length !== 4 || !fullTime.replay || fullTime.phase !== 'over') throw new Error(`match summary or last-goal action missing: ${JSON.stringify(fullTime)}`)
  await page.screenshot({ path: `${out}/06-match-summary.png` })
  const darkSummary = await page.evaluate(() => {
    const card = document.querySelector('[data-modal="winner"] .match-summary')
    const cs = getComputedStyle(card)
    const mode = getComputedStyle(document.querySelector('[data-summary-mode]'))
    return { theme: document.documentElement.dataset.theme, bg: cs.backgroundColor, mode: mode.color, sheetBg: getComputedStyle(card.closest('.sheet')).backgroundColor }
  })
  if (darkSummary.theme !== 'dark' || darkSummary.bg === 'rgb(243, 238, 226)' || darkSummary.mode === 'rgb(86, 80, 74)') throw new Error(`match summary did not repaint for dark mode: ${JSON.stringify(darkSummary)}`)
  for (const [label, width, height] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(120)
    const bounds = await page.locator('[data-modal="winner"] .match-summary').evaluate(el => {
      const r = el.getBoundingClientRect()
      const replay = el.querySelector('[data-summary-replay]').getBoundingClientRect()
      const actions = el.querySelector('[data-win-actions]').getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, scroll: el.scrollHeight - el.clientHeight, replayBottom: replay.bottom, actionsBottom: actions.bottom, viewport: innerHeight }
    })
    if (bounds.top < -1 || bounds.bottom > height + 1) throw new Error(`${label} summary card clips outside the phone viewport: ${JSON.stringify(bounds)}`)
    if (bounds.replayBottom > height + 1 || bounds.actionsBottom > height + 1 || (label === 'landscape' && bounds.scroll > 8)) throw new Error(`${label} summary actions require scrolling or are clipped: ${JSON.stringify(bounds)}`)
    await page.screenshot({ path: `${out}/06-summary-phone-${label}.png` })
  }
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.click('[data-summary-replay]')
  await waitForFunction(page, () => window.__capball.replay?.returnToSummary === true, 5000)
  const finalScore = [...s.goals]
  await waitForFunction(page, () => window.__capball.replay === null && document.querySelector('[data-modal="winner"].is-active'), 20000)
  if (JSON.stringify((await state(page)).goals) !== JSON.stringify(finalScore)) throw new Error('summary replay mutated the completed match score')
  // The user can also skip a replay and return to the same summary card immediately.
  await page.click('[data-summary-replay]')
  await waitForFunction(page, () => window.__capball.replay?.returnToSummary === true, 5000)
  await page.click('[data-replay]')
  await page.waitForSelector('[data-modal="winner"].is-active')
  if (JSON.stringify((await state(page)).goals) !== JSON.stringify(finalScore)) throw new Error('skipping the last-goal replay did not preserve the finished result')
  await page.click('[data-modal="winner"] [data-action="restart"]')
  s = await state(page)
  if (s.goals[0] !== 0 || s.goals[1] !== 0 || s.phase !== 'aim') throw new Error(`restart failed ${JSON.stringify(s)}`)
  const counts1 = await page.evaluate(() => window.__capball.debugCounts())
  await clickPauseAction(page, 'newmatch')
  await page.waitForSelector('[data-screen="start"].is-active')
  await startMode(page, 'mode:quick')
  const counts2 = await page.evaluate(() => window.__capball.debugCounts())
  console.log('smoke: listener counts', JSON.stringify({ counts0, counts1, counts2 }))
  if (JSON.stringify(counts0) !== JSON.stringify(counts1) || JSON.stringify(counts1) !== JSON.stringify(counts2)) throw new Error('listener counts changed across restart/new match')

  // ---------- Round 2: tuning overlay + spin flick with a real off-centre grab ----------
  await clickPauseAction(page, 'newmatch')
  await page.waitForSelector('[data-screen="start"].is-active')
  const debugUrl = new URL(url)
  debugUrl.searchParams.set('debug', '1')
  await page.goto(debugUrl.toString())
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-action="settings"]')
  await page.waitForSelector('[data-modal="settings"].is-active')
  if (!(await page.locator('[data-setting-row="tuning"]').isVisible())) throw new Error('debug flag did not reveal tuning setting')
  await page.click('[data-setting-switch="tuning"]')
  await page.click('[data-modal="settings"] [data-action="closemodal"]')
  await startMode(page, 'mode:quick')
  await page.click('.hud-tools [data-action="pause"]')
  if (!(await page.isVisible('[data-tune-btn]'))) throw new Error('Tune button not shown with tuning tools on')
  await clickPauseAction(page, 'tune')
  await page.locator('[data-modal="pause"] [data-action="resume"]').evaluate(el => el.click())
  await page.waitForFunction(() => !document.querySelector('[data-modal="pause"].is-active'))
  await page.waitForSelector('.tune:not([hidden])')
  {
    const c = await capScreen(page, 4)
    // Grab below centre (right of travel for a rightward flick) → anticlockwise spin → curls up.
    await page.mouse.move(c.x, c.y + 18)
    await page.mouse.down()
    await page.mouse.move(c.x - 60, c.y + 18, { steps: 5 })
    await page.mouse.move(c.x - 120, c.y + 18, { steps: 5 })
    await page.waitForTimeout(120)
    const aimSpin = await page.evaluate(() => window.__capball.aim?.spin ?? 0)
    if (!(aimSpin < -0.2)) throw new Error(`off-centre grab gave no spin: ${aimSpin}`)
    await page.screenshot({ path: `${out}/21-spin-aim.png` })
    await page.mouse.up()
    const w = await page.evaluate(() => window.__capball.match.world.caps[4].angularVelocity)
    if (!(w < 0)) throw new Error(`flicked cap not spinning anticlockwise: ${w}`)
    await waitPhase(page, () => window.__capball.match.phase === 'aim')
    const last = await page.evaluate(() => window.__capball.tune.last)
    if (!last || last.playMs === null || !(last.capDist > 20) || !(last.spin < 0) || !(last.curl < 0)) throw new Error(`overlay stats wrong: ${JSON.stringify(last && { ...last, capPath: last.capPath.length, ballPath: last.ballPath.length })}`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/22-tune-panel.png` })
    // Live slider → config, export, reset.
    const before = await page.evaluate(() => window.__capball.tune.catalog.find(t => t.id === 'PHYSICS.curl').get())
    await page.$eval('.tune input[data-tid="PHYSICS.curl"]', el => { el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true })) })
    const after = await page.evaluate(() => window.__capball.tune.catalog.find(t => t.id === 'PHYSICS.curl').get())
    if (after !== 5) throw new Error(`slider did not change PHYSICS.curl: ${after}`)
    await page.click('.tune [data-t="export"]')
    const text = await page.$eval('.tune [data-texport]', el => el.value)
    if (!text.includes('PHYSICS.curl') || !text.includes('→ 5')) throw new Error(`export missing change:\n${text}`)
    await page.click('.tune [data-t="reset"]')
    const reset = await page.evaluate(() => window.__capball.tune.catalog.find(t => t.id === 'PHYSICS.curl').get())
    if (reset !== before) throw new Error(`reset did not restore curl: ${reset} vs ${before}`)
    // No stacking across restart / new match with the overlay attached.
    const t0 = await page.evaluate(() => window.__capball.debugCounts())
    await page.evaluate(() => window.__capball.tune.setOpen(false))
    await clickPauseAction(page, 'restart')
    await clickPauseAction(page, 'newmatch')
    await page.waitForSelector('[data-screen="start"].is-active')
    await startMode(page, 'mode:quick')
    const t1 = await page.evaluate(() => window.__capball.debugCounts())
    console.log('smoke: overlay counts', JSON.stringify({ t0, t1 }))
    if (JSON.stringify(t0) !== JSON.stringify(t1) || t1.overlays !== 1) throw new Error('overlay listeners changed across restart/new match')
    await clickPauseAction(page, 'newmatch')
    await page.waitForSelector('[data-screen="start"].is-active')
    await page.click('[data-action="settings"]')
    await page.waitForSelector('[data-modal="settings"].is-active')
    await page.click('[data-setting-switch="tuning"]')
    await page.click('[data-modal="settings"] [data-action="closemodal"]')
    if (await page.isVisible('.tune')) throw new Error('overlay still open after turning tuning tools off')
    await page.click('[data-action="mode:quick"]')
    await page.click('[data-screen="setup"] [data-action="go"]')
    await page.waitForSelector('[data-screen="hud"].is-active')
  }

  // ---------- Phase 2: setup sheet, rulesets and every surface ----------
  // Real-physics corner: the defending team blasts the ball into its own end board.
  {
    s = await state(page)
    const defTeam = s.team
    const end = defTeam === 1 ? 1 : 0 // a team defends the goal at its own end
    await page.evaluate(([t, e]) => {
      const w = window.__capball.match.world
      w.caps.forEach((b, i) => w.place(b, { x: 500, y: 25 + i * 60 }))
      const bx = e === 1 ? 930 : 70
      w.place(w.ball, { x: bx, y: 90 })
      w.place(w.caps[t === 0 ? 2 : 7], { x: e === 1 ? 860 : 140, y: 90 })
    }, [defTeam, end])
    await mouseFlick(page, defTeam === 0 ? 2 : 7, end === 1 ? -120 : 120, 0)
    await waitPhase(page, () => window.__capball.match.phase === 'aim', 20000)
    const r = await page.evaluate(() => ({ reason: window.__capball.match.reason, team: window.__capball.match.team }))
    if (r.reason !== 'corner' || r.team === defTeam) throw new Error(`hard clearance into own end board should give a corner: ${JSON.stringify(r)}`)
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/24-corner.png` })
  }
  await clickPauseAction(page, 'newmatch')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-action="mode:quick"]')
  await page.waitForSelector('[data-screen="setup"].is-active')
  await page.click('[data-action="preset:proper"]')
  const darkSetup = await page.locator('.setup-wrap').evaluate(el => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(el).backgroundColor }))
  if (darkSetup.theme !== 'dark' || darkSetup.bg === 'rgb(243, 238, 226)') throw new Error(`setup screen did not stay dark: ${JSON.stringify(darkSetup)}`)
  await page.screenshot({ path: `${out}/11-setup.png` })
  for (const surf of ['dusty', 'rooftop', 'court', 'slope', 'carpark', 'park']) {
    const pitchCount = await page.locator('[data-screen="setup"] [data-action^="surface:"]').count()
    if (pitchCount < 6) throw new Error(`setup offers only ${pitchCount} pitches`)
    await page.click(`[data-action="surface:${surf}"]`)
    await page.click('[data-screen="setup"] [data-action="go"]')
    await page.waitForSelector('[data-screen="hud"].is-active')
    await page.waitForTimeout(200)
    const info = await page.evaluate(() => ({ surface: window.__capball.match.world.surface.id, rules: window.__capball.match.ruleset.id, offside: window.__capball.match.ruleset.offside, timed: !!window.__capball.match.ruleset.halves }))
    if (info.surface !== surf || info.rules !== 'proper' || !info.offside || !info.timed) throw new Error(`setup not applied: ${JSON.stringify(info)}`)
    if (surf !== 'park') await page.screenshot({ path: `${out}/12-surface-${surf}.png` })
    await clickPauseAction(page, 'newmatch')
    await page.click('[data-action="mode:quick"]')
    await page.waitForSelector('[data-screen="setup"].is-active')
  }
  // Back to the default preset for later runs.
  await page.click('[data-action="preset:street"]')
  await page.click('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  // Real foul: team 0 striker flicked straight into an opponent, ball far away.
  await page.evaluate(() => {
    const w = window.__capball.match.world
    w.caps.forEach((b, i) => w.place(b, { x: 80 + i * 90, y: 580 }))
    w.place(w.ball, { x: 500, y: 60 })
    w.place(w.caps[4], { x: 420, y: 300 })
    w.place(w.caps[7], { x: 520, y: 300 })
  })
  await mouseFlick(page, 4, -110, 0)
  await waitPhase(page, () => window.__capball.match.phase === 'aim')
  const fk = await page.evaluate(() => ({ team: window.__capball.match.team, reason: window.__capball.match.reason, ball: window.__capball.match.world.ball.position }))
  if (fk.team !== 1 || fk.reason !== 'freekick') throw new Error(`foul not called: ${JSON.stringify(fk)}`)
  await page.screenshot({ path: `${out}/13-freekick.png` })
  // Power shot button appears once charged and arms on click.
  await page.evaluate(() => { const m = window.__capball.match; m.possession.powerReady[1] = true; window.__capball.refreshPowerButtonPublic() })
  await page.click('[data-action="arm"]')
  if (!(await page.evaluate(() => window.__capball.match.armed === 1))) throw new Error('power shot did not arm')
  await page.screenshot({ path: `${out}/14-powershot-armed.png` })

  // ---------- Phase 3: cap designer ----------
  await clickPauseAction(page, 'newmatch')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-screen="start"] [data-action="editor"]')
  await page.waitForSelector('[data-screen="editor"].is-active')
  await page.fill('[data-input="team:0:name"]', 'Bin Men FC')
  await page.fill('[data-input="team:0:cname:4"]', 'Dazza')
  await page.fill('[data-input="team:0:num:4"]', '10')
  await page.click('[data-action="swatch:0:primary:#9b5cff"]')
  await page.click('[data-action="pattern:0:stripes"]')
  await page.click('[data-action="swatch:1:primary:#9b5cff"]') // clash on purpose → warning
  if (!(await page.isVisible('[data-warn]'))) throw new Error('colour clash warning missing')
  await page.screenshot({ path: `${out}/15-editor.png`, fullPage: true })
  await page.click('[data-action="swatch:1:primary:#2fbf71"]')
  if (await page.isVisible('[data-warn]')) throw new Error('clash warning stuck')
  await page.click('[data-action="editor-done"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  const saved = await page.evaluate(() => { const t = window.__capball.settings.teams[0]; return { name: t.name, primary: t.primary, pattern: t.pattern, n: t.numbers[4], c: t.capNames[4] } })
  if (saved.name !== 'Bin Men FC' || saved.primary !== '#9b5cff' || saved.pattern !== 'stripes' || saved.n !== '10' || saved.c !== 'Dazza') throw new Error(`design not saved: ${JSON.stringify(saved)}`)
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('capball.v1')).teams[0].name)
  if (persisted !== 'Bin Men FC') throw new Error('design not persisted')

  // ---------- Phase 3: penalty shootout through the real UI ----------
  await startMode(page, 'mode:shootout')
  if (!(await page.evaluate(() => window.__capball.match.keeperSetting))) throw new Error('shootout should start with the keeper')
  // Drag the keeper along the line with the mouse.
  const kId = await page.evaluate(() => window.__capball.match.keeperId)
  const k0 = await page.evaluate(id => window.__capball.match.world.caps[id].position.y, kId)
  const kp = await capScreen(page, kId)
  await page.mouse.move(kp.x, kp.y); await page.mouse.down(); await page.mouse.move(kp.x, kp.y - 60, { steps: 6 }); await page.mouse.up()
  const k1 = await page.evaluate(id => window.__capball.match.world.caps[id].position.y, kId)
  if (!(k1 < k0 - 20)) throw new Error(`keeper did not slide: ${k0} → ${k1}`)
  if (await page.evaluate(() => window.__capball.match.phase) !== 'aim') throw new Error('keeper drag must not start play')
  await page.screenshot({ path: `${out}/16-shootout-keeper.png` })
  await page.click('[data-action="keeperready"]')
  const tId = await page.evaluate(() => window.__capball.match.takerId)
  await mouseFlick(page, tId, -150, -20) // drag back-left = shoot right, slightly low
  await waitPhase(page, () => ['goal', 'reset', 'aim', 'over'].includes(window.__capball.match.phase) && window.__capball.match.phase !== 'moving')
  await waitPhase(page, () => window.__capball.match.phase === 'aim' && window.__capball.match.keeperSetting, 10000)
  const tally = await page.evaluate(() => window.__capball.match.shootout.kicks)
  if (tally[0].length !== 1) throw new Error(`kick not recorded: ${JSON.stringify(tally)}`)
  await page.screenshot({ path: `${out}/17-shootout-after.png` })
  await page.evaluate(() => {
    const m = window.__capball.match
    m.events.emit('win', { team: 0, score: m.score, reason: 'shootout' })
  })
  await page.waitForSelector('[data-modal="winner"].is-active')
  const shootoutSummary = await page.evaluate(() => ({ label: document.querySelector('[data-summary-label]')?.textContent, replayHidden: document.querySelector('[data-summary-replay]').hidden }))
  if (shootoutSummary.label !== 'Penalty shootout score' || !shootoutSummary.replayHidden) throw new Error(`shootout summary labels/replay mismatch: ${JSON.stringify(shootoutSummary)}`)

  // ---------- Phase 3: tournament ----------
  await page.click('[data-modal="winner"] [data-action="newmatch"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.locator('[data-screen="start"] [data-action="mode:tournament"]').click()
  await page.waitForTimeout(100)
  const tournamentTransition = await page.evaluate(() => ({ current: window.__capball.ui.root.dataset.current, mode: window.__capball.mode, dialogs: [...document.querySelectorAll('[data-modal].is-active')].map(el => el.dataset.modal), start: document.querySelector('[data-screen="start"]').classList.contains('is-active'), setup: document.querySelector('[data-screen="setup"]').classList.contains('is-active') }))
  if (!tournamentTransition.setup) throw new Error(`tournament button did not open setup: ${JSON.stringify(tournamentTransition)}`)
  await page.waitForSelector('[data-screen="setup"].is-active')
  await page.click('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="bracket"].is-active')
  await page.screenshot({ path: `${out}/18-bracket.png` })
  await page.click('[data-action="playtie"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  const crews = await page.evaluate(() => window.__capball.teams.map(t => t.name))
  if (crews[0] !== 'Bin Men FC' || crews[1] !== 'Alley Cats') throw new Error(`semi 1 crews wrong: ${crews}`)
  for (let k = 0; k < 6; k++) {
    s = await state(page)
    if (s.phase === 'over') break
    // Let team 0 win: team 0 shoots at goal, team 1 dribbles harmlessly.
    if (s.team === 0) { await lineUpShot(page, 0); await mouseFlick(page, 4, -140, 0) }
    else await mouseFlick(page, 9, 0, -60)
    await finishPlay(page)
  }
  await page.waitForSelector('[data-modal="winner"].is-active')
  await page.click('[data-action="bracket"]')
  await page.waitForSelector('[data-screen="bracket"].is-active')
  const tour = await page.evaluate(() => window.__capball.tournament.ties.map(t => [t.id, t.result?.winner ?? null, t.home, t.away]))
  if (tour[0][1] !== 0 || tour[2][2] !== 0) throw new Error(`bracket not advanced: ${JSON.stringify(tour)}`)
  await page.screenshot({ path: `${out}/19-bracket-after.png` })
  const counts3 = await page.evaluate(() => window.__capball.debugCounts())
  if (counts3.input !== 1) throw new Error(`input handlers stacked: ${JSON.stringify(counts3)}`)

  // ---------- Versus-AI tournament + cup finale ----------
  await page.click('[data-screen="bracket"] [data-action="back"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-screen="start"] [data-action="mode:tournament"]')
  await page.waitForSelector('[data-screen="setup"].is-active [data-tournament-choice]')
  const tournamentDefault = await page.evaluate(() => ({
    local: document.querySelector('[data-action="tournament-ai:no"]')?.classList.contains('is-on'),
    versus: document.querySelector('[data-action="tournament-ai:yes"]')?.classList.contains('is-on'),
    aiPicker: !!document.querySelector('[data-action="ai-level:medium"]'),
  }))
  if (!tournamentDefault.local || tournamentDefault.versus || tournamentDefault.aiPicker) {
    throw new Error(`tournament setup did not default to Local 2P: ${JSON.stringify(tournamentDefault)}`)
  }
  await page.click('[data-action="tournament-ai:yes"]')
  await page.waitForSelector('[data-screen="setup"].is-active [data-action="ai-level:hard"]')
  const tournamentAiChoice = await page.evaluate(() => ({
    local: document.querySelector('[data-action="tournament-ai:no"]')?.classList.contains('is-on'),
    versus: document.querySelector('[data-action="tournament-ai:yes"]')?.classList.contains('is-on'),
    label: document.querySelector('[data-tournament-choice] label')?.textContent,
  }))
  if (tournamentAiChoice.local || !tournamentAiChoice.versus || tournamentAiChoice.label !== 'Who plays the tournament?') {
    throw new Error(`Versus AI choice did not take: ${JSON.stringify(tournamentAiChoice)}`)
  }
  await page.click('[data-action="ai-level:hard"]')
  await page.click('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="bracket"].is-active')
  const aiBracket = await page.evaluate(() => {
    const a = window.__capball
    return {
      ai: a.aiTournament,
      setting: a.settings.tournamentAi,
      crews: a.tournament.crews.map(t => t.name),
      ties: a.tournament.ties.map(t => ({ id: t.id, simulated: !!t.result?.simulated, home: t.home, away: t.away, winner: t.result?.winner ?? null })),
      copy: document.querySelector('[data-bracket]')?.innerText ?? '',
    }
  })
  if (!aiBracket.ai || !aiBracket.setting) throw new Error(`Versus-AI bracket is not active: ${JSON.stringify(aiBracket)}`)
  if (JSON.stringify(aiBracket.crews) !== JSON.stringify(['Bin Men FC', 'Alley Cats', 'Concrete Cobras', 'Pigeon Patrol'])) {
    throw new Error(`Versus-AI roster is wrong: ${JSON.stringify(aiBracket.crews)}`)
  }
  if (aiBracket.ties[1].simulated !== true || aiBracket.ties[0].winner !== null) {
    throw new Error(`AI-only semi did not auto-resolve: ${JSON.stringify(aiBracket.ties)}`)
  }
  if (!aiBracket.copy.includes('you vs Concrete Cobras') || !aiBracket.copy.includes('Street Legend AI')) {
    throw new Error(`Versus-AI bracket is missing opponent/difficulty: ${aiBracket.copy}`)
  }
  await page.screenshot({ path: `${out}/20-ai-bracket.png` })

  // Semi-final: real Versus-AI match shells with the human crew on team 0.
  await page.click('[data-action="playtie"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  const aiMatch = await page.evaluate(() => ({
    mode: window.__capball.mode,
    ai: !!window.__capball.aiBrain,
    teams: window.__capball.teams.map(t => t.name),
  }))
  if (!aiMatch.ai || aiMatch.mode !== 'tournament' || aiMatch.teams[0] !== 'Bin Men FC' || aiMatch.teams[1] !== 'Concrete Cobras') {
    throw new Error(`Versus-AI match did not start correctly: ${JSON.stringify(aiMatch)}`)
  }
  // Match play is covered above; set a real score then concede to advance the bracket deterministically.
  await page.evaluate(() => {
    const a = window.__capball
    a.match.score.goals = [3, 1]
    a.match.concede(0)
  })
  await page.waitForSelector('[data-modal="winner"].is-active')
  const semiWin = await page.evaluate(() => ({
    title: document.querySelector('[data-summary-title]')?.textContent,
    actions: document.querySelector('[data-win-actions]')?.innerText ?? '',
  }))
  if (!semiWin.actions.includes('Continue')) throw new Error(`semi-final win did not offer the bracket: ${JSON.stringify(semiWin)}`)
  await page.click('[data-action="bracket"]')
  await page.waitForSelector('[data-screen="bracket"].is-active')
  const finalPair = await page.evaluate(() => ({
    next: window.__capball.tournament.next?.id,
    home: window.__capball.tournament.ties[2].home,
    away: window.__capball.tournament.ties[2].away,
    champion: window.__capball.tournament.champion,
  }))
  if (finalPair.next !== 'final' || finalPair.home !== 0 || finalPair.away === null || finalPair.champion !== null) {
    throw new Error(`human semi win did not reach the final: ${JSON.stringify(finalPair)}`)
  }
  await page.click('[data-action="playtie"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.evaluate(() => {
    const a = window.__capball
    a.match.score.goals = [2, 0]
    a.match.concede(0)
  })
  await page.waitForSelector('[data-modal="winner"].is-active')
  const cupAction = await page.locator('[data-win-actions]').innerText()
  if (!cupAction.includes('Lift the cup')) throw new Error(`champion did not offer the cup screen: ${cupAction}`)
  await page.click('[data-action="cup"]')
  await page.waitForSelector('[data-screen="cup"].is-active')
  const cup = await page.evaluate(() => {
    const a = window.__capball
    return {
      champion: a.tournament.champion,
      name: document.querySelector('.cup-champ')?.textContent,
      champVar: document.querySelector('.cup-champ')?.style.getPropertyValue('--champ'),
      trophy: !!document.querySelector('.cup-trophy svg'),
      finalScores: [...document.querySelectorAll('.cup-final-side strong')].map(el => el.textContent.trim()),
      finalLabel: document.querySelector('.cup-final-label')?.textContent,
      caps: document.querySelectorAll('.cup-crew canvas').length,
      ties: document.querySelectorAll('.cup-wrap .tie').length,
      actions: [...document.querySelectorAll('.cup-actions [data-action]')].map(el => el.dataset.action),
      headline: document.querySelector('.cup-wrap h2')?.textContent,
      layout: (() => {
        const card = document.querySelector('.cup-wrap').getBoundingClientRect()
        const screen = document.querySelector('.screen-cup')
        return { top: card.top, bottom: card.bottom, height: card.height, client: screen.clientHeight, scroll: screen.scrollHeight, viewport: innerHeight }
      })(),
    }
  })
  console.log('smoke: cup layout', JSON.stringify(cup.layout))
  if (cup.layout.top < -1 || (cup.layout.scroll > cup.layout.client + 2 && cup.layout.height > cup.layout.viewport)) {
    throw new Error(`cup screen clips its card: ${JSON.stringify(cup.layout)}`)
  }
  if (cup.champion !== 0 || cup.name !== 'Bin Men FC' || !cup.champVar || !cup.trophy) {
    throw new Error(`cup winner screen is wrong: ${JSON.stringify(cup)}`)
  }
  if (JSON.stringify(cup.finalScores) !== JSON.stringify(['2', '0']) || cup.finalLabel !== 'Cup final') {
    throw new Error(`cup final score is wrong: ${JSON.stringify(cup)}`)
  }
  if (cup.caps !== 5 || cup.ties !== 3 || !cup.actions.includes('mode:tournament') || !cup.actions.includes('back')) {
    throw new Error(`cup screen is missing crew/bracket/actions: ${JSON.stringify(cup)}`)
  }
  await page.screenshot({ path: `${out}/21-ai-cup.png` })

  // Eliminated path: the human loses the semi and the final resolves between the AI crews.
  await page.click('.cup-actions [data-action="back"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-screen="start"] [data-action="mode:tournament"]')
  await page.waitForSelector('[data-screen="setup"].is-active [data-action="ai-level:hard"]')
  const persistedChoice = await page.evaluate(() => document.querySelector('[data-action="tournament-ai:yes"]')?.classList.contains('is-on'))
  if (!persistedChoice) throw new Error('Versus AI choice was not remembered between tournaments')
  await page.click('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="bracket"].is-active')
  await page.click('[data-action="playtie"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.evaluate(() => {
    const a = window.__capball
    a.match.score.goals = [1, 4]
    a.match.concede(1)
  })
  await page.waitForSelector('[data-modal="winner"].is-active')
  const eliminated = await page.evaluate(() => ({
    title: document.querySelector('[data-summary-title]')?.textContent,
    actions: document.querySelector('[data-win-actions]')?.innerText ?? '',
    champion: window.__capball.tournament.champion,
    finalSimulated: !!window.__capball.tournament.ties[2].result?.simulated,
  }))
  if (eliminated.champion === 0 || eliminated.champion === null) throw new Error(`AI champion missing after human exit: ${JSON.stringify(eliminated)}`)
  if (!eliminated.finalSimulated) throw new Error(`AI-vs-AI final was not auto-resolved: ${JSON.stringify(eliminated)}`)
  if (!eliminated.title?.includes('Your run ends here') || !eliminated.actions.includes('See who lifts the cup')) {
    throw new Error(`elimination summary is dishonest or missing the cup: ${JSON.stringify(eliminated)}`)
  }
  await page.click('[data-action="cup"]')
  await page.waitForSelector('[data-screen="cup"].is-active')
  const aiCup = await page.evaluate(() => {
    const a = window.__capball
    const champion = a.tournament.champion
    return {
      champion,
      name: document.querySelector('.cup-champ')?.textContent,
      expected: a.tournament.crews[champion].name,
      sub: document.querySelector('.cup-sub')?.textContent,
      ties: document.querySelectorAll('.cup-wrap .tie').length,
      simulated: a.tournament.ties.filter(t => t.result?.simulated).length,
    }
  })
  if (aiCup.champion === 0 || aiCup.name !== aiCup.expected) {
    throw new Error(`cup screen did not show the actual AI champion: ${JSON.stringify(aiCup)}`)
  }
  if (!aiCup.sub?.includes('street machine takes the cup') || aiCup.ties !== 3 || aiCup.simulated < 1) {
    throw new Error(`eliminated cup screen is incomplete: ${JSON.stringify(aiCup)}`)
  }
  await page.screenshot({ path: `${out}/22-ai-cup-eliminated.png` })
  await page.click('.cup-actions [data-action="back"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await desk.close()

  // ---------- Local hidden penalty commit–reveal ----------
  const hiddenCtx = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const hiddenPage = await open(hiddenCtx)
  await hiddenPage.click('[data-action="mode:quick"]')
  if (await hiddenPage.$('[data-modal="tutorial-prompt"].is-active')) await hiddenPage.click('[data-action="tutorial:skip-prompt"]')
  await hiddenPage.waitForSelector('[data-screen="setup"].is-active')
  await hiddenPage.click('[data-input="flag:hiddenPenalties"]')
  await hiddenPage.waitForFunction(() => document.querySelector('input[data-input="flag:hiddenPenalties"]')?.checked)
  await hiddenPage.click('[data-screen="setup"] [data-action="go"]')
  await hiddenPage.waitForSelector('[data-screen="hud"].is-active')
  await hiddenPage.evaluate(() => {
    const a = window.__capball
    window.__hiddenFlicks = 0
    a.match.events.on('flick', () => { window.__hiddenFlicks++ })
    if (!a.match.awardInputFoul({ x: 30, y: 310 })) throw new Error('penalty-rule test call rejected')
  })
  await hiddenPage.waitForFunction(() => window.__capball.hiddenPenalty?.stage === 'cover-keeper', null, { timeout: 10000 })
  if (await hiddenPage.$('[data-modal="rule-hint"].is-active')) {
    const ruleCard = await hiddenPage.locator('[data-modal="rule-hint"]').innerText()
    if (!ruleCard.includes('Penalty')) throw new Error(`unexpected rule card before hidden penalty: ${ruleCard}`)
    await hiddenPage.click('[data-modal="rule-hint"] [data-action="rulehint:close"]')
  }
  await hiddenPage.waitForSelector('[data-modal="penalty"].is-active')
  await hiddenPage.click('[data-modal="penalty"] [data-action="penalty-cover"]')
  const keeperId = await hiddenPage.evaluate(() => window.__capball.hiddenPenalty.keeperId)
  const keeperBefore = await hiddenPage.evaluate(id => window.__capball.match.world.caps[id].position.y, keeperId)
  const keeperPoint = await capScreen(hiddenPage, keeperId)
  await hiddenPage.mouse.move(keeperPoint.x, keeperPoint.y)
  await hiddenPage.mouse.down()
  await hiddenPage.mouse.move(keeperPoint.x, keeperPoint.y - 60, { steps: 6 })
  await hiddenPage.mouse.up()
  const keeperMoved = await hiddenPage.evaluate(id => window.__capball.match.world.caps[id].position.y, keeperId)
  if (!(keeperMoved < keeperBefore - 20)) throw new Error(`hidden keeper could not move: ${keeperBefore} → ${keeperMoved}`)
  await hiddenPage.click('[data-action="keeper-lock"]')
  await hiddenPage.waitForFunction(() => window.__capball.hiddenPenalty?.stage === 'cover-shooter')
  await hiddenPage.click('[data-modal="penalty"] [data-action="penalty-cover"]')
  const lockedKeeper = await hiddenPage.evaluate(() => ({
    committed: window.__capball.hiddenPenalty.keeperPosition,
    visible: window.__capball.match.world.caps[window.__capball.hiddenPenalty.keeperId].position,
  }))
  if (Math.abs(lockedKeeper.visible.y - 310) > 2 || Math.abs(lockedKeeper.committed.y - 310) < 20) throw new Error(`keeper lock was not hidden from shooter: ${JSON.stringify(lockedKeeper)}`)
  const takerId = await hiddenPage.evaluate(() => window.__capball.hiddenPenalty.takerId)
  const stagedBall = await hiddenPage.evaluate(() => ({ ...window.__capball.match.world.ball.position }))
  await mouseFlick(hiddenPage, takerId, 110, 0)
  const staged = await hiddenPage.evaluate(() => ({
    phase: window.__capball.hiddenPenalty?.stage,
    candidate: window.__capball.hiddenPenalty?.candidateShot,
    committed: window.__capball.hiddenPenalty?.committedShot,
    flicks: window.__hiddenFlicks,
    ball: { ...window.__capball.match.world.ball.position },
  }))
  if (staged.phase !== 'shooter' || !staged.candidate || staged.committed || staged.flicks !== 0 || staged.ball.x !== stagedBall.x || staged.ball.y !== stagedBall.y) throw new Error(`staged penalty became visible/executed early: ${JSON.stringify(staged)}`)
  await hiddenPage.click('[data-action="shot-lock"]')
  await hiddenPage.waitForSelector('[data-modal="penalty-reveal"].is-active')
  await hiddenPage.waitForFunction(() => window.__capball.hiddenPenalty === null && window.__hiddenFlicks === 1, null, { timeout: 5000 })
  await hiddenPage.screenshot({ path: `${out}/28-hidden-penalty.png` })
  await hiddenCtx.close()

  // ---------- Phase 3: offline install ----------
  const off = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const op = await open(off)
  const manifest = await op.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return r.json() })
  if (manifest.display !== 'standalone' || !manifest.icons.some(i => i.purpose === 'maskable')) throw new Error('manifest incomplete')
  await op.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 15000 })
  await op.evaluate(() => navigator.serviceWorker.ready)
  await op.reload()
  await op.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 })
  await off.setOffline(true)
  await op.reload()
  await op.waitForSelector('[data-screen="start"].is-active', { timeout: 15000 })
  await startMode(op, 'mode:quick')
  await op.screenshot({ path: `${out}/20-offline.png` })
  await off.setOffline(false)
  await off.close()

  // ---------- phone portrait / real touch ----------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const phoneDebugUrl = new URL(url)
  phoneDebugUrl.searchParams.set('debug', '1')
  const pp = await open(phone, phoneDebugUrl.toString())
  await assertStartMenu(pp, 'phone portrait')
  await pp.click('[data-action="settings"]')
  await pp.waitForSelector('[data-modal="settings"].is-active')
  if (!(await pp.locator('[data-setting-row="tuning"]').isVisible())) throw new Error('debug flag did not expose Tuning Tools')
  await pp.screenshot({ path: `${out}/07-phone-settings-debug.png` })
  await pp.click('[data-setting-switch="tuning"]')
  if (!(await pp.evaluate(() => window.__capball.settings.tuning))) throw new Error('debug Tuning Tools switch did not enable the overlay')
  await pp.click('[data-setting-switch="tuning"]')
  await pp.click('[data-modal="settings"] [data-action="closemodal"]')
  await pp.screenshot({ path: `${out}/07-phone-start.png` })
  await startMode(pp, 'mode:quick', true)
  await assertHudPause(pp, 'phone portrait')
  const cdp = await phone.newCDPSession(pp)
  const t0 = await capScreen(pp, 4)
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  await touch('touchStart', t0.x, t0.y)
  // Portrait is rotated (team 0 attacks up the screen): drag DOWN to flick up.
  for (let i = 1; i <= 8; i++) await touch('touchMove', t0.x + i * 2, t0.y + i * 12)
  await pp.waitForTimeout(120)
  await pp.screenshot({ path: `${out}/08-phone-aim.png` })
  await touch('touchEnd', 0, 0)
  const ps = await state(pp)
  if (ps.phase !== 'moving') throw new Error(`touch flick did not start: ${JSON.stringify(ps)}`)
  const dir = await pp.evaluate(() => window.__capball.match.world.caps[4].velocity)
  if (!(dir.x > 0)) throw new Error(`portrait flick went the wrong way: ${JSON.stringify(dir)}`)
  if ((await pp.evaluate(() => window.scrollY + document.documentElement.scrollTop)) !== 0) throw new Error('page scrolled during touch drag')
  await waitPhase(pp, () => window.__capball.match.phase === 'aim')
  await pp.screenshot({ path: `${out}/09-phone-after.png` })
  await pp.evaluate(() => { const a = window.__capball; a.setTuning(true); a.tune.setOpen(true) })
  await pp.waitForTimeout(300)
  await pp.screenshot({ path: `${out}/23-phone-tune.png` })
  await pp.evaluate(() => { const a = window.__capball; a.tune.setOpen(false); a.setTuning(false) })
  await phone.close()

  // ---------- phone landscape ----------
  const land = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const lp = await open(land)
  await assertStartMenu(lp, 'phone landscape')
  await lp.screenshot({ path: `${out}/10-phone-landscape-start.png` })
  await startMode(lp, 'mode:quick', true)
  await assertHudPause(lp, 'phone landscape')
  await lp.screenshot({ path: `${out}/10-phone-landscape.png` })
  await land.close()

  // ---------- Phase 4: local AI opponent ----------
  const aiCtx = await browser.newContext({ viewport: { width: 1050, height: 760 } })
  const aip = await open(aiCtx)
  await aip.locator('.start-more summary').click()
  await aip.click('[data-action="mode:ai"]')
  await aip.waitForSelector('[data-screen="setup"].is-active [data-action="ai-level:easy"]')
  await aip.click('[data-screen="setup"] [data-action="ai-level:easy"]')
  await aip.click('[data-screen="setup"] [data-action="go"]')
  await aip.waitForSelector('[data-screen="hud"].is-active')
  const level = await aip.evaluate(() => window.__capball.settings.aiLevel)
  if (level !== 'easy') throw new Error(`AI difficulty did not persist: ${level}`)
  await aip.evaluate(() => {
    const m = window.__capball.match
    m.world.caps.forEach((b, i) => m.world.place(b, { x: -1500 - i * 80, y: -1500 }))
    // A gentle, real-physics human touch starts the first turn and lets the AI respond.
    m.world.place(m.world.caps[4], { x: 445, y: 310 })
    m.world.place(m.world.ball, { x: 475, y: 310 })
    if (!m.tryFlick(4, { x: 1, y: 0 }, 0.12)) throw new Error('human opening flick rejected')
  })
  await waitPhase(aip, () => window.__capball.match.team === 1 && window.__capball.match.phase === 'aim', 20000)
  await waitPhase(aip, () => window.__capball.match.phase === 'moving' && window.__capball.match.activeCap >= 5, 20000)
  await aip.screenshot({ path: `${out}/25-ai-reply.png` })
  await aiCtx.close()

  // ---------- Phase 4: two real browser clients over the authoritative room server ----------
  const onlineCtxA = await browser.newContext({ viewport: { width: 1080, height: 760 } })
  const onlineA = await open(onlineCtxA)
  await onlineA.click('[data-invite-entry]')
  await onlineA.waitForSelector('[data-screen="online"].is-active')
  await onlineA.waitForSelector('[data-action="online:create"]:not([disabled])', { timeout: 5000 })
  const onlinePitches = await onlineA.locator('[data-screen="online"] [data-action^="surface:"]').count()
  if (onlinePitches < 6) throw new Error(`invite screen offers only ${onlinePitches} pitches`)
  await onlineA.click('[data-screen="online"] [data-action="surface:carpark"]')
  await onlineA.waitForSelector('[data-screen="online"] [data-action="surface:carpark"].is-on')
  if (await onlineA.evaluate(() => window.__capball.settings.surface) !== 'carpark') throw new Error('invite pitch choice was not kept')
  await onlineA.waitForSelector('[data-action="online:create"]:not([disabled])', { timeout: 5000 })
  await onlineA.click('[data-action="online:create"]')
  await onlineA.waitForSelector('[data-screen="hud"].is-active', { timeout: 15000 })
  await onlineA.waitForFunction(() => window.__capball.onlineState?.ready === false && window.__capball.onlineClient?.state === 'open', null, { timeout: 15000 })
  const room = await onlineA.evaluate(() => window.__capball.onlineClient.room)
  if (!room) throw new Error('room server did not assign a room code')
  const waitCard = await onlineA.locator('[data-online-wait]').evaluate(el => ({
    hidden: el.hidden,
    code: el.querySelector('[data-online-wait-code]')?.textContent?.trim(),
    copy: el.querySelector('[data-online-wait-copy]')?.textContent ?? '',
  }))
  if (waitCard.hidden || waitCard.code !== room || !/waiting for your mate/i.test(waitCard.copy)) throw new Error(`waiting-for-mate card is missing the room code: ${JSON.stringify(waitCard)}`)
  await clickPauseAction(onlineA, 'online-copy')
  await onlineA.waitForFunction(code => document.querySelector('[data-caption]')?.textContent.includes(code), room, { timeout: 5000 })
  await clickPauseAction(onlineA, 'resume')
  await onlineA.screenshot({ path: `${out}/26-online-waiting.png` })

  const invite = new URL(url)
  invite.searchParams.set('room', room)
  const onlineCtxB = await browser.newContext({ viewport: { width: 1080, height: 760 } })
  const onlineB = await open(onlineCtxB, invite.href)
  await onlineB.click('[data-invite-entry]') // deep link auto-joins the room
  await onlineB.waitForSelector('[data-screen="hud"].is-active', { timeout: 15000 })
  await onlineA.waitForFunction(() => window.__capball.onlineState?.ready && window.__capball.onlineTeam === 0, null, { timeout: 15000 })
  await onlineB.waitForFunction(() => window.__capball.onlineState?.ready && window.__capball.onlineTeam === 1, null, { timeout: 15000 })
  await onlineA.waitForFunction(() => document.querySelector('[data-online-wait]')?.hidden === true, null, { timeout: 5000 })
  const pitches = await Promise.all([onlineA, onlineB].map(p => p.evaluate(() => ({
    wire: window.__capball.onlineState?.surface,
    world: window.__capball.match?.world.surface.id,
  }))))
  if (pitches.some(p => p.wire !== 'carpark' || p.world !== 'carpark')) throw new Error(`host pitch was not shared with both seats: ${JSON.stringify(pitches)}`)
  const seatOnePickable = await onlineB.evaluate(() => window.__capball.pickable().map(c => c.id))
  if (seatOnePickable.length) throw new Error(`second online seat received input while team 0 had the turn: ${seatOnePickable}`)
  await onlineA.screenshot({ path: `${out}/27-online-ready.png` })

  // ---------- measured link diagnostics under the delay/jitter proxy ----------
  await onlineA.waitForFunction(() => {
    const d = window.__capball.debugOnline()
    return d.rttMs !== null && Number.isFinite(d.rttMs) && d.seq > 0
  }, null, { timeout: 15000 })
  const diagBefore = await onlineA.evaluate(() => window.__capball.debugOnline())
  if (diagBefore.rttMs < 10 || diagBefore.rttMs > 2000) throw new Error(`online RTT was not measured through the delay proxy: ${JSON.stringify(diagBefore)}`)
  await onlineA.click('.hud-tools [data-action="pause"]')
  await onlineA.waitForSelector('[data-modal="pause"].is-active')
  await onlineA.waitForTimeout(650)
  const diagUi = await onlineA.locator('[data-modal="pause"] [data-online-diag]').evaluate(el => {
    const sheet = el.closest('.pause-sheet')
    const r = sheet.getBoundingClientRect()
    return {
      hidden: el.hidden,
      rtt: el.querySelector('[data-diag="rtt"]')?.textContent ?? '',
      jitter: el.querySelector('[data-diag="jitter"]')?.textContent ?? '',
      seq: el.querySelector('[data-diag="seq"]')?.textContent ?? '',
      correction: el.querySelector('[data-diag="correction"]')?.textContent ?? '',
      reconnects: el.querySelector('[data-diag="reconnects"]')?.textContent ?? '',
      overflow: r.top < -1 || r.bottom > innerHeight + 1 || sheet.scrollHeight > sheet.clientHeight + 1,
    }
  })
  if (diagUi.hidden || !/ms/.test(diagUi.rtt) || !/^\d+$/.test(diagUi.seq) || diagUi.reconnects !== '0' || diagUi.overflow) {
    throw new Error(`online pause diagnostics are missing or unmeasured: ${JSON.stringify(diagUi)}`)
  }
  await onlineA.screenshot({ path: `${out}/31-online-pause-diagnostics.png` })
  // The same sheet must still fit a short landscape phone with the diagnostics row shown.
  await onlineA.setViewportSize({ width: 844, height: 390 })
  await onlineA.waitForTimeout(250)
  const diagLandscape = await onlineA.locator('[data-modal="pause"].is-active .pause-sheet').evaluate(sheet => {
    const r = sheet.getBoundingClientRect()
    const buttons = [...sheet.querySelectorAll('.pause-actions .btn, .pause-resume, .pause-concede')].filter(el => !el.hidden && el.offsetParent)
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom), innerHeight,
      scroll: sheet.scrollHeight - sheet.clientHeight,
      small: buttons.filter(el => el.getBoundingClientRect().height < 44).map(el => el.textContent.trim()),
      diag: sheet.querySelector('[data-online-diag]')?.hidden === false,
    }
  })
  if (diagLandscape.top < -1 || diagLandscape.bottom > diagLandscape.innerHeight + 1 || diagLandscape.scroll > 1 || diagLandscape.small.length || !diagLandscape.diag) {
    throw new Error(`online pause sheet does not fit landscape with diagnostics: ${JSON.stringify(diagLandscape)}`)
  }
  await onlineA.screenshot({ path: `${out}/32-online-pause-landscape.png` })
  await onlineA.setViewportSize({ width: 1080, height: 760 })
  await onlineA.waitForTimeout(150)
  await onlineA.keyboard.press('Escape')
  await onlineA.waitForFunction(() => !document.querySelector('[data-modal="pause"]').classList.contains('is-active'))

  await mouseFlick(onlineA, 4, -105, 5)
  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'moving', 15000)
  await waitForFunction(onlineB, () => window.__capball.onlineState?.phase === 'moving', 15000)
  // Under the delay/jitter proxy the two seats can be a snapshot apart at any instant. Convergence
  // means both seats apply the same authoritative sequence, not that their arrival times match.
  const seenA = new Map()
  const seenB = new Map()
  let converged = null
  for (let i = 0; i < 80 && !converged; i++) {
    const [a, b] = await Promise.all([onlineA, onlineB].map(p => p.evaluate(() => ({ seq: window.__capball.onlineState?.seq, body: window.__capball.onlineState?.bodies[4] }))))
    if (a.seq !== undefined) seenA.set(a.seq, a.body)
    if (b.seq !== undefined) seenB.set(b.seq, b.body)
    for (const [seq, bodyA] of seenA) {
      if (seenB.has(seq)) { converged = { seq, bodyA, bodyB: seenB.get(seq) }; break }
    }
    if (!converged) await new Promise(r => setTimeout(r, 25))
  }
  if (!converged) throw new Error('seats never applied the same authoritative snapshot sequence')
  const snapshotA = converged.bodyA
  const snapshotB = converged.bodyB
  if (Math.abs(snapshotA.x - snapshotB.x) > 1 || Math.abs(snapshotA.y - snapshotB.y) > 1) throw new Error(`authoritative board did not converge across seats at seq ${converged.seq}: ${JSON.stringify({ snapshotA, snapshotB })}`)
  await onlineA.waitForFunction(prev => window.__capball.debugOnline().seq > prev, diagBefore.seq, { timeout: 10000 })
  const diagAfter = await onlineA.evaluate(() => window.__capball.debugOnline())
  if (!(diagAfter.smoother.residualPx <= 240) || !(diagAfter.smoother.maxResidualPx <= 240) || diagAfter.pendingPredictions > 20) {
    throw new Error(`online reconciliation exceeded its bounds: ${JSON.stringify(diagAfter)}`)
  }
  console.log(`smoke: online link — RTT ${diagAfter.rttMs} ms, jitter ${diagAfter.jitterMs} ms, snapshot ${diagAfter.seq}, corrections ${diagAfter.corrections} (last ${diagAfter.lastCorrectionPx} px, max ${diagAfter.maxCorrectionPx} px), render residual ${diagAfter.smoother.residualPx} px, snaps ${diagAfter.smoother.snapped}, stale ${diagAfter.stale}, gaps ${diagAfter.gaps}`)
  await onlineA.screenshot({ path: `${out}/28-online-flick.png` })

  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'aim' && window.__capball.onlineState?.team === 1, 30000)
  await waitForFunction(onlineB, () => window.__capball.onlineState?.phase === 'aim' && window.__capball.onlineState?.team === 1, 30000)
  await mouseFlick(onlineB, 9, 105, -4)
  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'moving' && window.__capball.onlineState?.team === 1, 15000)
  await onlineB.screenshot({ path: `${out}/29-online-reply.png` })
  await onlineCtxA.close()
  await onlineCtxB.close()

  // ---------- the Invite a Mate help screen is honest when no public room server exists ----------
  const offlineCtx = await browser.newContext({ viewport: { width: 1000, height: 720 } })
  await offlineCtx.route('**/multiplayer/bootstrap.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, build: 'capball-online-v1', signalingUrl: '' }),
  }))
  const offline = await open(offlineCtx)
  await offline.click('[data-invite-entry]')
  await offline.waitForSelector('[data-screen="online"].is-active')
  await offline.waitForSelector('[data-online-config][data-state="off"]', { timeout: 5000 })
  const offUi = await offline.evaluate(() => ({
    note: document.querySelector('[data-online-config]')?.textContent ?? '',
    status: document.querySelector('[data-online-status]')?.textContent ?? '',
    createDisabled: document.querySelector('[data-action="online:create"]')?.disabled === true,
    joinDisabled: document.querySelector('[data-action="online:join"]')?.disabled === true,
  }))
  if (!/not configured/i.test(offUi.note) || !/public room server/i.test(offUi.status) || !offUi.createDisabled || !offUi.joinDisabled) {
    throw new Error(`online should fail closed when unconfigured: ${JSON.stringify(offUi)}`)
  }
  await offline.screenshot({ path: `${out}/30-online-unconfigured.png` })
  await offlineCtx.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
