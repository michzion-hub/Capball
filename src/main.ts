import './styles/main.css'
import { App } from './app'
import { registerServiceWorker } from './pwa'

const canvas = document.querySelector<HTMLCanvasElement>('#game')!
const ui = document.querySelector<HTMLElement>('#ui')!

// Make sure display fonts are ready before caps cache their number sprites.
const fontsReady = Promise.all([
  document.fonts.load('40px Bangers'),
  document.fonts.load('20px "Permanent Marker"'),
]).catch(() => undefined)

const boot = document.getElementById('boot')
void fontsReady.then(() => {
  try {
    const app = new App(canvas, ui)
    ;(window as unknown as { __capball: App }).__capball = app
    if (import.meta.hot) import.meta.hot.dispose(() => app.destroy())
    if (boot) { boot.style.opacity = '0'; setTimeout(() => boot.remove(), 320) }
  } catch (err) {
    console.error(err)
    if (boot) {
      boot.classList.add('err')
      const msg = document.getElementById('boot-msg')
      if (msg) msg.innerHTML = 'Something broke. <button onclick="location.reload()" style="font:inherit;padding:4px 10px">Retry</button>'
    }
  }
})

registerServiceWorker()
