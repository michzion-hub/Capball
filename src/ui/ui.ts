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
  private restartTimer = 0
  private settingsReturnFocus: HTMLElement | null = null

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
    root.addEventListener('keydown', e => {
      const dialog = this.root.querySelector<HTMLElement>('[data-modal="settings"].is-active')
      if (!dialog) return
      if (e.key === 'Escape') { e.preventDefault(); this.modal(null); return }
      if (e.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
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
    window.clearTimeout(this.restartTimer)
    this.$('[data-banner]').classList.remove('show')
    this.$('[data-caption]').classList.remove('show')
    this.$('[data-restart-banner]').classList.remove('show')
    this.setPenaltyTimer(null)
  }

  modal(name: string | null): void {
    const current = this.root.querySelector<HTMLElement>('.modal.is-active')
    if (name === 'settings' && !current) this.settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    for (const s of this.$$('[data-modal]')) {
      const active = s.dataset.modal === name
      s.classList.toggle('is-active', active)
      s.setAttribute('aria-hidden', String(!active))
    }
    this.root.classList.toggle('has-modal', name !== null)
    if (name === 'settings') {
      this.$('[data-modal="settings"] [data-setting-switch]:not([disabled])').focus()
    } else if (name === null && current?.dataset.modal === 'settings') {
      const target = this.settingsReturnFocus
      this.settingsReturnFocus = null
      if (target?.isConnected) target.focus()
    }
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
    this.setSettingSwitch('sound', on)
    for (const b of this.$$('[data-action="sound"]')) {
      b.classList.toggle('is-off', !on)
      b.setAttribute('aria-pressed', String(on))
      const l = b.querySelector('.lbl')
      if (l) l.textContent = on ? 'Sound on' : 'Sound off'
    }
  }

  setSettingSwitch(name: string, on: boolean): void {
    const button = this.root.querySelector<HTMLButtonElement>(`[data-setting-switch="${name}"]`)
    if (!button) return
    button.setAttribute('aria-checked', String(on))
    const state = button.querySelector<HTMLElement>('[data-setting-state]')
    if (state) state.textContent = on ? 'On' : 'Off'
  }

  setSettingAvailable(name: string, available: boolean, unavailableText: string): void {
    const button = this.root.querySelector<HTMLButtonElement>(`[data-setting-switch="${name}"]`)
    if (!button) return
    button.disabled = !available
    button.setAttribute('aria-disabled', String(!available))
    const description = this.root.querySelector<HTMLElement>(`[data-setting-description="${name}"]`)
    if (description && !available) description.textContent = unavailableText
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

  restartBanner(text: string, color: string, ms = 1800): void {
    const b = this.$('[data-restart-banner]')
    b.textContent = text
    b.style.setProperty('--team', color)
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show')
    window.clearTimeout(this.restartTimer)
    this.restartTimer = window.setTimeout(() => b.classList.remove('show'), ms)
  }

  setPenaltyTimer(seconds: number | null): void {
    const el = this.$('[data-penalty-timer]')
    el.hidden = seconds === null
    if (seconds !== null) {
      el.textContent = `LOCK IN · ${seconds}`
      el.classList.toggle('urgent', seconds <= 3)
    } else el.classList.remove('urgent')
  }

  showPenaltyCover(title: string, body: string, button: string, color: string): void {
    const modal = this.$('[data-modal="penalty"]')
    modal.style.setProperty('--team', color)
    modal.querySelector('[data-penalty-title]')!.textContent = title
    modal.querySelector('[data-penalty-copy]')!.textContent = body
    modal.querySelector('[data-action="penalty-cover"]')!.textContent = button
    this.modal('penalty')
  }

  showPenaltyReveal(text: string, color: string): void {
    const modal = this.$('[data-modal="penalty-reveal"]')
    modal.style.setProperty('--team', color)
    modal.querySelector('[data-penalty-reveal-copy]')!.textContent = text
    this.modal('penalty-reveal')
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
    window.clearTimeout(this.restartTimer)
    this.root.innerHTML = ''
  }
}

export { esc }

const TEMPLATE = /* html */ `
<section class="screen screen-start" data-screen="start">
  <div class="start-wrap">
    <div class="tape tape-a"></div>
    <h1 class="logo" aria-label="CAPBALL"><span>CAP</span><span class="logo-cap" aria-hidden="true"></span><span>BALL</span></h1>
    <button class="gear-button" type="button" data-action="settings" aria-label="Open settings" aria-haspopup="dialog" aria-controls="settings-modal" title="Settings">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 8.1a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8Zm8 4.8v-1.8l-2-.7a6.4 6.4 0 0 0-.6-1.4l.9-1.9-1.3-1.3-1.9.9a6.4 6.4 0 0 0-1.4-.6l-.7-2h-1.8l-.7 2a6.4 6.4 0 0 0-1.4.6l-1.9-.9-1.3 1.3.9 1.9a6.4 6.4 0 0 0-.6 1.4l-2 .7v1.8l2 .7a6.4 6.4 0 0 0 .6 1.4l-.9 1.9 1.3 1.3 1.9-.9a6.4 6.4 0 0 0 1.4.6l.7 2h1.8l.7-2a6.4 6.4 0 0 0 1.4-.6l1.9.9 1.3-1.3-.9-1.9a6.4 6.4 0 0 0 .6-1.4l2-.7Z"/></svg>
      <span class="sr-only">Settings</span>
    </button>
    <p class="tagline">Bottle-cap street football. Two thumbs, one table, no mercy.</p>
    <div class="start-menu" data-start-menu></div>
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
    <button class="tool" data-action="pause" title="Pause">Pause</button>
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
<div class="restart-banner" data-restart-banner aria-live="polite"></div>
<div class="penalty-timer" data-penalty-timer hidden aria-live="polite"></div>

<div class="modal" data-modal="rules" role="dialog" aria-label="Rules">
  <div class="sheet">
    <div class="tape tape-b"></div>
    <h2>How to play</h2>
    <div class="rules-body" data-rules-body></div>
    <button class="btn" data-action="closemodal">Got it</button>
  </div>
</div>

<div class="modal settings-modal" data-modal="settings" id="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-hidden="true">
  <div class="sheet settings-sheet">
    <div class="tape tape-b"></div>
    <span class="settings-kicker">Match atmosphere</span>
    <h2 id="settings-title">Settings</h2>
    <p class="settings-intro">Turn the sideline noise on or off.</p>
    <div class="settings-list" data-settings-options>
      <div class="setting-row" data-setting-row="commentary">
        <div class="setting-copy"><span class="setting-title" id="setting-commentary-title">Commentary</span><span class="setting-description" id="setting-commentary-description" data-setting-description="commentary">On-screen match calls and captions.</span></div>
        <button class="setting-switch" type="button" role="switch" data-setting-switch="commentary" data-action="toggle:commentary" aria-checked="true" aria-labelledby="setting-commentary-title" aria-describedby="setting-commentary-description"><span data-setting-state>On</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>
      </div>
      <div class="setting-row" data-setting-row="speech">
        <div class="setting-copy"><span class="setting-title" id="setting-speech-title">Voice</span><span class="setting-description" id="setting-speech-description" data-setting-description="speech">Spoken match commentary.</span></div>
        <button class="setting-switch" type="button" role="switch" data-setting-switch="speech" data-action="toggle:speech" aria-checked="false" aria-labelledby="setting-speech-title" aria-describedby="setting-speech-description"><span data-setting-state>Off</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>
      </div>
      <div class="setting-row" data-setting-row="sound">
        <div class="setting-copy"><span class="setting-title" id="setting-sound-title">Sound</span><span class="setting-description" id="setting-sound-description" data-setting-description="sound">Whistles, impacts and crowd audio.</span></div>
        <button class="setting-switch" type="button" role="switch" data-setting-switch="sound" data-action="toggle:sound" aria-checked="true" aria-labelledby="setting-sound-title" aria-describedby="setting-sound-description"><span data-setting-state>On</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>
      </div>
      <div class="setting-row" data-setting-row="tuning" hidden>
        <div class="setting-copy"><span class="setting-title" id="setting-tuning-title">Tuning Tools</span><span class="setting-description" id="setting-tuning-description" data-setting-description="tuning">Developer-only game tuning panel.</span></div>
        <button class="setting-switch" type="button" role="switch" data-setting-switch="tuning" data-action="toggle:tuning" aria-checked="false" aria-labelledby="setting-tuning-title" aria-describedby="setting-tuning-description"><span data-setting-state>Off</span><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></button>
      </div>
    </div>
    <button class="btn settings-done" type="button" data-action="closemodal">Done</button>
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

<div class="modal penalty-cover-modal" data-modal="penalty" role="dialog" aria-modal="true" aria-label="Pass the phone">
  <div class="sheet penalty-cover">
    <span class="kicker">Hidden penalty · pass the device</span>
    <h2 data-penalty-title></h2>
    <p data-penalty-copy></p>
    <button class="btn" data-action="penalty-cover">I'm ready</button>
  </div>
</div>

<div class="modal penalty-cover-modal" data-modal="penalty-reveal" role="dialog" aria-modal="true" aria-label="Penalty choices revealed">
  <div class="sheet penalty-cover">
    <span class="kicker">Both choices locked</span>
    <h2>The reveal</h2>
    <p data-penalty-reveal-copy></p>
  </div>
</div>

<div class="modal" data-modal="pause" role="dialog" aria-modal="true" aria-label="Match paused">
  <div class="sheet">
    <span class="kicker">Match paused</span>
    <h2>Take a breather</h2>
    <div class="win-actions">
      <button class="btn" data-action="resume">Resume</button>
      <button class="btn ghost" data-action="restart">Restart</button>
      <button class="btn ghost" data-action="concede-match">Concede</button>
      <button class="chip" data-action="newmatch">New match</button>
    </div>
  </div>
</div>
`
