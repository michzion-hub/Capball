// Design regression check for the street-zine visual identity: `npm run design:check`.
// Serves the built dist/ (the npm script builds first; a bare run needs `npm run build`),
// or set DESIGN_URL to check a dev server instead. Verifies geometry at the canonical
// smoke sizes plus the zine material tells — grain on paper surfaces, stacked-flyer
// shadows, logo misregistration, tape strips, menu tilt rhythm. Screenshots: shots/design/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const external = process.env.DESIGN_URL
const port = 4300 + Math.floor(Math.random() * 500)
const url = external ?? `http://127.0.0.1:${port}/`
const out = 'shots/design'
mkdirSync(out, { recursive: true })

const server = external ? null : spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
)

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}

const browser = await chromium.launch()
const issues = []
const note = (msg) => issues.push(msg)

async function open(ctx, name) {
  const page = await ctx.newPage()
  const errors = []
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(url)
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
  if (errors.length) note(`${name}: console errors: ${errors.join(' | ')}`)
  return page
}

const menuGeometry = (page, label) => page.evaluate(label => {
  const btns = [...document.querySelectorAll('[data-screen="start"] .start-main-actions .menu-main')]
  const card = document.querySelector('.start-wrap')
  const rect = card.getBoundingClientRect()
  return {
    label,
    order: btns.map(b => b.textContent.trim()),
    widths: btns.map(b => b.offsetWidth),
    heights: btns.map(b => b.offsetHeight),
    equalWidth: Math.max(...btns.map(b => b.offsetWidth)) - Math.min(...btns.map(b => b.offsetWidth)),
    cardTop: Math.round(rect.top), cardBottom: Math.round(rect.bottom),
    scrollOverflow: card.parentElement.scrollHeight - card.parentElement.clientHeight,
    cardOverflowsViewport: rect.bottom > innerHeight + 1 || rect.top < -1,
    summaryHeights: document.querySelector('.start-more summary').offsetHeight,
    chipHeights: [...document.querySelectorAll('.start-more-actions .chip')].map(c => c.offsetHeight),
  }
}, label)

try {
  if (server) await waitForServer()

  for (const [name, vp, mobile] of [
    ['desktop', { width: 1280, height: 760 }, false],
    ['portrait', { width: 390, height: 844 }, true],
    ['landscape', { width: 844, height: 390 }, true],
  ]) {
    const ctx = await browser.newContext({
      viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
    })
    const page = await open(ctx, name)

    // --- start menu ---
    await page.screenshot({ path: `${out}/${name}-01-start.png` })
    const menu = await menuGeometry(page, name)
    if (menu.equalWidth > 1) note(`${name}: main buttons unequal widths: ${menu.widths}`)
    if (menu.heights.some(h => h < 44)) note(`${name}: button under 44px: ${menu.heights}`)
    if (menu.heights[0] <= Math.max(...menu.heights.slice(1))) note(`${name}: primary not taller: ${menu.heights}`)
    if (menu.cardOverflowsViewport || menu.scrollOverflow > 2) note(`${name}: menu clips/scrolls: ${JSON.stringify(menu)}`)
    if (menu.summaryHeights < 44) note(`${name}: foldout summary under 44px: ${menu.summaryHeights}`)

    // --- zine material tells (once, on the visible start screen) ---
    if (name === 'desktop') {
      const zine = await page.evaluate(() => {
        const tapes = [...document.querySelectorAll('[data-screen="start"] .tape')]
        const btns = [...document.querySelectorAll('[data-screen="start"] .start-main-actions .menu-main')]
        const wrap = getComputedStyle(document.querySelector('.start-wrap'))
        const logo = getComputedStyle(document.querySelector('.logo span'))
        return {
          shadowLayers: (wrap.boxShadow.match(/rgb/g) || []).length,
          wrapGrain: wrap.backgroundImage.includes('svg+xml'),
          logoOffsetPrint: logo.textShadow !== 'none',
          tapes: tapes.map(t => ({ torn: getComputedStyle(t).clipPath !== 'none', visible: !!t.offsetParent })),
          tilts: btns.map(b => getComputedStyle(b).transform),
        }
      })
      if (zine.shadowLayers < 3) note(`flyer stack lost its layered shadow (${zine.shadowLayers} layers)`)
      if (!zine.wrapGrain) note('start card lost its grain layer')
      if (!zine.logoOffsetPrint) note('logo lost its misregistered print shadow')
      if (!zine.tapes.length || zine.tapes.some(t => !t.torn || !t.visible)) note(`tape strips missing, square or hidden: ${JSON.stringify(zine.tapes)}`)
      const tilted = zine.tilts.filter(t => t !== 'none')
      if (tilted.length < 3 || new Set(zine.tilts).size < 2) note(`menu tilt rhythm lost: ${JSON.stringify(zine.tilts)}`)
    }

    // --- settings sheet ---
    await page.click('.gear-button')
    await page.waitForSelector('[data-modal="settings"].is-active')
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${out}/${name}-02-settings.png` })
    const sheetFit = await page.evaluate(() => {
      const sheet = document.querySelector('[data-modal="settings"] .sheet')
      const r = sheet.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scroll: sheet.scrollHeight - sheet.clientHeight }
    })
    if (sheetFit.bottom > sheetFit.h + 1 || sheetFit.top < -1 || sheetFit.scroll > 2) note(`${name}: settings sheet overflows: ${JSON.stringify(sheetFit)}`)
    if (name === 'desktop') {
      const sheetGrain = await page.evaluate(() => getComputedStyle(document.querySelector('[data-modal="settings"] .sheet')).backgroundImage)
      if (!sheetGrain.includes('svg+xml')) note('settings sheet lost its grain layer')
    }
    await page.keyboard.press('Escape')

    // --- setup sheet ---
    // The setup screen is a long form and scrolls vertically by design; only flag horizontal scroll.
    await page.click('[data-action="mode:quick"]')
    const prompt = await page.$('[data-modal="tutorial-prompt"].is-active')
    if (prompt) {
      await page.click('[data-action="tutorial:skip-prompt"]')
      await page.waitForFunction(() => !document.querySelector('[data-modal="tutorial-prompt"]').classList.contains('is-active'))
    }
    await page.waitForSelector('[data-screen="setup"].is-active')
    await page.screenshot({ path: `${out}/${name}-03-setup.png` })
    const setupFit = await page.evaluate(() => {
      const wrap = document.querySelector('.setup-wrap')
      const r = wrap.getBoundingClientRect()
      const screen = document.querySelector('[data-screen="setup"]')
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scroll: screen.scrollHeight - screen.clientHeight, xScroll: screen.scrollWidth - screen.clientWidth }
    })
    if (setupFit.top < -1) note(`${name}: setup card clipped at top: ${JSON.stringify(setupFit)}`)
    if (setupFit.xScroll > 2) note(`${name}: setup screen scrolls horizontally: ${JSON.stringify(setupFit)}`)

    // --- into a match (HUD + pause sheet) ---
    await page.click('[data-setup] [data-action="go"]')
    await page.waitForSelector('[data-screen="hud"].is-active', { timeout: 15_000 })
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/${name}-04-hud.png` })
    const hud = await page.evaluate(() => {
      const pause = document.querySelector('.hud-tools .tool-pause')
      const bar = document.querySelector('.scorebar')
      return { pauseH: pause.offsetHeight, pauseW: pause.offsetWidth, barH: bar.offsetHeight }
    })
    if (hud.pauseH < 44) note(`${name}: pause under 44px: ${JSON.stringify(hud)}`)
    await page.click('.hud-tools .tool-pause')
    await page.waitForSelector('[data-modal="pause"].is-active')
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${out}/${name}-05-pause.png` })
    const pauseFit = await page.evaluate(() => {
      const sheet = document.querySelector('[data-modal="pause"] .pause-sheet')
      const r = sheet.getBoundingClientRect()
      const actions = [...sheet.querySelectorAll('button:not([hidden])')].map(b => b.offsetHeight)
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scroll: sheet.scrollHeight - sheet.clientHeight, minAction: Math.min(...actions) }
    })
    if (pauseFit.bottom > pauseFit.h + 1 || pauseFit.top < -1 || pauseFit.scroll > 2) note(`${name}: pause sheet overflows: ${JSON.stringify(pauseFit)}`)
    if (pauseFit.minAction < 44) note(`${name}: pause action under 44px: ${pauseFit.minAction}`)
    await ctx.close()
  }
} finally {
  await browser.close().catch(() => {})
  try { server?.kill('SIGTERM') } catch {}
}

if (issues.length) {
  console.error('DESIGN CHECK ISSUES:')
  for (const i of issues) console.error(' - ' + i)
  process.exit(1)
}
console.log('design check clean — screenshots in ' + out)
