// End-to-end smoke test: dist/ must already exist (`npm run build`).
// Serves dist/, plays real mouse and touch flicks in headless Chromium, walks the menus,
// fails on any console/page/network error, and writes screenshots to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const onlinePort = 48000 + Math.floor(Math.random() * 8000)
const url = `http://127.0.0.1:${port}/`
const onlineUrl = `ws://127.0.0.1:${onlinePort}/ws`
const allowedOrigin = `http://127.0.0.1:${port}`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const roomServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(onlinePort), CAPBALL_ALLOWED_ORIGINS: allowedOrigin } })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', env: { ...process.env, CAPBALL_WS_URL: onlineUrl } })
let browser
const guard = setTimeout(() => fail('timed out'), 240_000)
function cleanup() { clearTimeout(guard); try { server.kill('SIGTERM'); roomServer.kill('SIGTERM') } catch {} }
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
  throw new Error('preview server did not start')
}
async function waitForRoomServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${onlinePort}/healthz`)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('CAPBALL online server did not start')
}
const errors = []
async function open(context, href = url) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(href)
  await page.waitForSelector('[data-screen="start"].is-active', { timeout: 30_000 })
  await page.waitForFunction(() => !document.getElementById('boot'))
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
const waitPhase = (page, pred, ms = 15000) => page.waitForFunction(pred, null, { timeout: ms, polling: 50 })
const waitForFunction = (page, pred, ms = 15000) => page.waitForFunction(pred, null, { timeout: ms, polling: 50 })
/** Start a mode from the start screen; confirms the setup sheet when one exists. */
async function startMode(page, action, tap = false) {
  const press = sel => (tap ? page.tap(sel) : page.click(sel))
  await press(`[data-action="${action}"]`)
  if (await page.$('[data-screen="setup"].is-active')) await press('[data-screen="setup"] [data-action="go"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.waitForTimeout(250)
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

try {
  await waitForRoomServer()
  await waitForServer()
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))

  // ---------- desktop / mouse ----------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 760 } })
  const page = await open(desk)
  await page.screenshot({ path: `${out}/01-start.png` })
  await startMode(page, 'mode:quick')
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
  await page.click('.hud-tools [data-action="rules"]')
  await page.waitForSelector('[data-modal="rules"].is-active')
  await page.screenshot({ path: `${out}/05-rules.png` })
  await page.click('[data-modal="rules"] [data-action="closemodal"]')
  await page.click('.hud-tools [data-action="sound"]')
  if (!(await page.evaluate(() => window.__capball.settings.sound === false))) throw new Error('sound toggle failed')
  await page.click('.hud-tools [data-action="sound"]')

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
  await page.click('[data-modal="winner"] [data-action="restart"]')
  s = await state(page)
  if (s.goals[0] !== 0 || s.goals[1] !== 0 || s.phase !== 'aim') throw new Error(`restart failed ${JSON.stringify(s)}`)
  const counts1 = await page.evaluate(() => window.__capball.debugCounts())
  await page.click('.hud-tools [data-action="newmatch"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await startMode(page, 'mode:quick')
  const counts2 = await page.evaluate(() => window.__capball.debugCounts())
  console.log('smoke: listener counts', JSON.stringify({ counts0, counts1, counts2 }))
  if (JSON.stringify(counts0) !== JSON.stringify(counts1) || JSON.stringify(counts1) !== JSON.stringify(counts2)) throw new Error('listener counts changed across restart/new match')

  // ---------- Round 2: tuning overlay + spin flick with a real off-centre grab ----------
  await page.click('.hud-tools [data-action="newmatch"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-action="toggle:tuning"]')
  await startMode(page, 'mode:quick')
  if (!(await page.isVisible('[data-tune-btn]'))) throw new Error('Tune button not shown with tuning tools on')
  await page.click('[data-tune-btn]')
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
    await page.click('.hud-tools [data-action="restart"]')
    await page.click('.hud-tools [data-action="newmatch"]')
    await page.waitForSelector('[data-screen="start"].is-active')
    await startMode(page, 'mode:quick')
    const t1 = await page.evaluate(() => window.__capball.debugCounts())
    console.log('smoke: overlay counts', JSON.stringify({ t0, t1 }))
    if (JSON.stringify(t0) !== JSON.stringify(t1) || t1.overlays !== 1) throw new Error('overlay listeners changed across restart/new match')
    await page.click('.hud-tools [data-action="newmatch"]')
    await page.waitForSelector('[data-screen="start"].is-active')
    await page.click('[data-action="toggle:tuning"]')
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
  await page.click('.hud-tools [data-action="newmatch"]')
  await page.waitForSelector('[data-screen="start"].is-active')
  await page.click('[data-action="mode:quick"]')
  await page.waitForSelector('[data-screen="setup"].is-active')
  await page.click('[data-action="preset:proper"]')
  await page.screenshot({ path: `${out}/11-setup.png` })
  for (const surf of ['dusty', 'rooftop', 'court', 'slope', 'park']) {
    await page.click(`[data-action="surface:${surf}"]`)
    await page.click('[data-screen="setup"] [data-action="go"]')
    await page.waitForSelector('[data-screen="hud"].is-active')
    await page.waitForTimeout(200)
    const info = await page.evaluate(() => ({ surface: window.__capball.match.world.surface.id, rules: window.__capball.match.ruleset.id, offside: window.__capball.match.ruleset.offside, timed: !!window.__capball.match.ruleset.halves }))
    if (info.surface !== surf || info.rules !== 'proper' || !info.offside || !info.timed) throw new Error(`setup not applied: ${JSON.stringify(info)}`)
    if (surf !== 'park') await page.screenshot({ path: `${out}/12-surface-${surf}.png` })
    await page.click('.hud-tools [data-action="newmatch"]')
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
  await page.click('.hud-tools [data-action="newmatch"]')
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

  // ---------- Phase 3: tournament ----------
  await page.click('.hud-tools [data-action="newmatch"]')
  await page.click('[data-action="mode:tournament"]')
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
  await desk.close()

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
  const pp = await open(phone)
  await pp.screenshot({ path: `${out}/07-phone-start.png` })
  await startMode(pp, 'mode:quick', true)
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
  await startMode(lp, 'mode:quick', true)
  await lp.screenshot({ path: `${out}/10-phone-landscape.png` })
  await land.close()

  // ---------- Phase 4: local AI opponent ----------
  const aiCtx = await browser.newContext({ viewport: { width: 1050, height: 760 } })
  const aip = await open(aiCtx)
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
  await onlineA.click('[data-action="mode:online"]')
  await onlineA.waitForSelector('[data-screen="online"].is-active')
  await onlineA.click('[data-action="online:create"]')
  await onlineA.waitForSelector('[data-screen="hud"].is-active', { timeout: 15000 })
  await onlineA.waitForFunction(() => window.__capball.onlineState?.ready === false && window.__capball.onlineClient?.state === 'open', null, { timeout: 15000 })
  const room = await onlineA.evaluate(() => window.__capball.onlineClient.room)
  if (!room) throw new Error('room server did not assign a room code')
  await onlineA.click('[data-action="online-copy"]')
  await onlineA.waitForFunction(code => document.querySelector('[data-caption]')?.textContent.includes(code), room, { timeout: 5000 })
  await onlineA.screenshot({ path: `${out}/26-online-waiting.png` })

  const invite = new URL(url)
  invite.searchParams.set('room', room)
  const onlineCtxB = await browser.newContext({ viewport: { width: 1080, height: 760 } })
  const onlineB = await open(onlineCtxB, invite.href)
  await onlineB.click('[data-action="mode:online"]') // deep link auto-joins the room
  await onlineB.waitForSelector('[data-screen="hud"].is-active', { timeout: 15000 })
  await onlineA.waitForFunction(() => window.__capball.onlineState?.ready && window.__capball.onlineTeam === 0, null, { timeout: 15000 })
  await onlineB.waitForFunction(() => window.__capball.onlineState?.ready && window.__capball.onlineTeam === 1, null, { timeout: 15000 })
  const seatOnePickable = await onlineB.evaluate(() => window.__capball.pickable().map(c => c.id))
  if (seatOnePickable.length) throw new Error(`second online seat received input while team 0 had the turn: ${seatOnePickable}`)
  await onlineA.screenshot({ path: `${out}/27-online-ready.png` })

  await mouseFlick(onlineA, 4, -105, 5)
  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'moving', 15000)
  await waitForFunction(onlineB, () => window.__capball.onlineState?.phase === 'moving', 15000)
  const [snapshotA, snapshotB] = await Promise.all([
    onlineA.evaluate(() => window.__capball.onlineState.bodies[4]),
    onlineB.evaluate(() => window.__capball.onlineState.bodies[4]),
  ])
  if (Math.abs(snapshotA.x - snapshotB.x) > 1 || Math.abs(snapshotA.y - snapshotB.y) > 1) throw new Error(`authoritative board did not converge across seats: ${JSON.stringify({ snapshotA, snapshotB })}`)
  await onlineA.screenshot({ path: `${out}/28-online-flick.png` })

  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'aim' && window.__capball.onlineState?.team === 1, 30000)
  await waitForFunction(onlineB, () => window.__capball.onlineState?.phase === 'aim' && window.__capball.onlineState?.team === 1, 30000)
  await mouseFlick(onlineB, 9, 105, -4)
  await waitForFunction(onlineA, () => window.__capball.onlineState?.phase === 'moving' && window.__capball.onlineState?.team === 1, 15000)
  await onlineB.screenshot({ path: `${out}/29-online-reply.png` })
  await onlineCtxA.close()
  await onlineCtxB.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
