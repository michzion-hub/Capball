import type { TeamIndex } from '../physics/world'
import type { TeamDesign } from '../render/capArt'

export type Action = string

export interface UIHandlers {
  action(name: Action, el: HTMLElement): void
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * Thin DOM layer: renders screens and HUD, and forwards every button press through ONE
 * delegated listener (so re-rendering never stacks duplicate handlers).
 */
export class UI {
  readonly root: HTMLElement
  private abort = new AbortController()
  private bannerTimer = 0
  private captionTimer = 0

  constructor(root: HTMLElement, private readonly handlers: UIHandlers) {
    this.root = root
    root.innerHTML = TEMPLATE
    root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')
      if (!el || el.hasAttribute('disabled')) return
      e.preventDefault()
      this.handlers.action(el.dataset.action!, el)
    }, { signal: this.abort.signal })
    root.addEventListener('input', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-input]')
      if (el) this.handlers.action(`input:${el.dataset.input}`, el)
    }, { signal: this.abort.signal })
  }

  $(sel: string): HTMLElement { return this.root.querySelector<HTMLElement>(sel)! }
  $$(sel: string): HTMLElement[] { return [...this.root.querySelectorAll<HTMLElement>(sel)] }

  show(screen: string): void {
    for (const s of this.$$('[data-screen]')) s.classList.toggle('is-active', s.dataset.screen === screen)
    this.root.dataset.current = screen
    if (screen !== 'hud') this.clearOverlays()
  }

  /** Drop any in-flight banner/caption (they belong to the match that produced them). */
  clearOverlays(): void {
    window.clearTimeout(this.bannerTimer)
    window.clearTimeout(this.captionTimer)
    this.$('[data-banner]').classList.remove('show')
    this.$('[data-caption]').classList.remove('show')
  }

  modal(name: string | null): void {
    for (const s of this.$$('[data-modal]')) s.classList.toggle('is-active', s.dataset.modal === name)
    this.root.classList.toggle('has-modal', name !== null)
  }

  get modalOpen(): boolean { return this.root.classList.contains('has-modal') }

  setTeams(d: [TeamDesign, TeamDesign]): void {
    d.forEach((t, i) => {
      const slip = this.$(`[data-team-slip="${i}"]`)
      slip.style.setProperty('--team', t.primary)
      slip.style.setProperty('--team2', t.secondary)
      slip.querySelector('.slip-name')!.textContent = t.name
    })
  }

  setScore(goals: [number, number]): void {
    goals.forEach((g, i) => {
      const el = this.$(`[data-team-slip="${i}"] .slip-score`)
      if (el.textContent !== String(g)) {
        el.textContent = String(g)
        el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump')
      }
    })
  }

  setTurn(team: TeamIndex | null, d: [TeamDesign, TeamDesign], label: string): void {
    const t = this.$('[data-turn]')
    if (team === null) { t.classList.remove('is-on'); return }
    t.classList.add('is-on')
    t.style.setProperty('--team', d[team].primary)
    t.querySelector('.turn-who')!.textContent = d[team].name
    t.querySelector('.turn-what')!.textContent = label
    for (const i of [0, 1]) this.$(`[data-team-slip="${i}"]`).classList.toggle('on-turn', i === team)
  }

  setClock(text: string | null): void {
    const c = this.$('[data-clock]')
    c.hidden = text === null
    if (text !== null) c.textContent = text
  }

  setSound(on: boolean): void {
    for (const b of this.$$('[data-action="sound"]')) {
      b.classList.toggle('is-off', !on)
      b.setAttribute('aria-pressed', String(on))
      const l = b.querySelector('.lbl')
      if (l) l.textContent = on ? 'Sound on' : 'Sound off'
    }
  }

  banner(text: string, color = '#ff5a1f', ms = 1400, big = false): void {
    const b = this.$('[data-banner]')
    b.textContent = text
    b.style.setProperty('--team', color)
    b.classList.toggle('big', big)
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show')
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), ms)
  }

  caption(text: string, ms = 2600): void {
    const c = this.$('[data-caption]')
    c.textContent = text
    c.classList.add('show')
    window.clearTimeout(this.captionTimer)
    this.captionTimer = window.setTimeout(() => c.classList.remove('show'), ms)
  }

  showWinner(title: string, sub: string, color: string): void {
    const w = this.$('[data-modal="winner"]')
    w.style.setProperty('--team', color)
    w.querySelector('.win-title')!.textContent = title
    w.querySelector('.win-sub')!.textContent = sub
    this.modal('winner')
  }

  html(sel: string, markup: string): void { this.$(sel).innerHTML = markup }

  destroy(): void {
    this.abort.abort()
    window.clearTimeout(this.bannerTimer)
    window.clearTimeout(this.captionTimer)
    this.root.innerHTML = ''
  }
}

export { esc }

const TEMPLATE = /* html */ `
<section class="screen screen-start" data-screen="start">
  <div class="start-wrap">
    <div class="tape tape-a"></div>
    <h1 class="logo" aria-label="CAPBALL"><span>CAP</span><span class="logo-cap" aria-hidden="true"></span><span>BALL</span></h1>
    <p class="tagline">Bottle-cap street football. Two thumbs, one table, no mercy.</p>
    <div class="start-menu" data-start-menu></div>
    <div class="start-foot">
      <button class="chip" data-action="rules">How to play</button>
      <button class="chip" data-action="sound"><span class="lbl">Sound on</span></button>
    </div>
  </div>
</section>

<section class="screen screen-setup" data-screen="setup"><div class="setup-wrap" data-setup></div></section>
<section class="screen screen-online" data-screen="online"><div class="online-wrap" data-online></div></section>
<section class="screen screen-editor" data-screen="editor"><div class="editor-wrap" data-editor></div></section>
<section class="screen screen-bracket" data-screen="bracket"><div class="bracket-wrap" data-bracket></div></section>

<section class="screen screen-hud" data-screen="hud">
  <header class="scorebar">
    <div class="slip" data-team-slip="0"><span class="slip-cap"></span><span class="slip-name"></span><span class="slip-score">0</span></div>
    <div class="mid">
      <div class="clock" data-clock hidden>0:00</div>
      <div class="turn" data-turn><span class="turn-who"></span><span class="turn-what"></span></div>
    </div>
    <div class="slip right" data-team-slip="1"><span class="slip-score">0</span><span class="slip-name"></span><span class="slip-cap"></span></div>
  </header>
  <div class="meters" data-meters></div>
  <nav class="hud-tools">
    <button class="tool" data-action="restart" data-local-restart title="Restart this match">Restart</button>
    <button class="tool" data-action="newmatch" title="Back to the menu">New match</button>
    <button class="tool" data-action="online-copy" data-online-copy hidden>Invite link</button>
    <button class="tool" data-action="online-leave" data-online-leave hidden>Leave room</button>
    <button class="tool" data-action="rules" title="Rules">Rules</button>
    <button class="tool" data-action="sound" title="Sound"><span class="lbl">Sound on</span></button>
    <button class="tool tool-tune" data-action="tune" title="Tuning overlay (\`)" data-tune-btn hidden>Tune</button>
  </nav>
  <div class="powerbtn-slot" data-powerbtn></div>
  <button class="replay-tag" data-replay data-action="skipreplay" hidden>REPLAY <small>tap to skip</small></button>
</section>

<div class="banner" data-banner></div>
<div class="caption" data-caption></div>

<div class="modal" data-modal="rules" role="dialog" aria-label="Rules">
  <div class="sheet">
    <div class="tape tape-b"></div>
    <h2>How to play</h2>
    <div class="rules-body" data-rules-body></div>
    <button class="btn" data-action="closemodal">Got it</button>
  </div>
</div>

<div class="modal" data-modal="winner" role="dialog" aria-label="Full time">
  <div class="sheet win">
    <div class="tape tape-a"></div>
    <p class="win-kicker">Full time</p>
    <h2 class="win-title"></h2>
    <p class="win-sub"></p>
    <div class="win-actions" data-win-actions>
      <button class="btn" data-action="restart">Rematch</button>
      <button class="btn ghost" data-action="newmatch">New match</button>
    </div>
  </div>
</div>

<div class="modal" data-modal="confirm" role="dialog">
  <div class="sheet">
    <h2 data-confirm-title>Sure?</h2>
    <p data-confirm-text></p>
    <div class="win-actions">
      <button class="btn" data-action="confirm-yes">Yes</button>
      <button class="btn ghost" data-action="closemodal">No</button>
    </div>
  </div>
</div>
`
