import type { TeamIndex } from '../physics/world'
import type { TeamDesign } from '../render/capArt'
import type { RuleHintContent } from '../game/ruleHints'

export type Action = string

export interface UIHandlers {
  action(name: Action, el: HTMLElement): void
}

export interface SummaryStatRow {
  label: string
  values: [number, number]
}

export interface MatchSummaryView {
  headline: string
  teams: [string, string]
  score: [number, number]
  scoreLabel: string
  mode: string
  duration: string
  color: string
  stats: SummaryStatRow[]
  replayAvailable: boolean
}

export interface TutorialCoachView {
  stepIndex: number
  stepLabel: string
  title: string
  copy: string
  status: string
  hint: string
  hintAvailable: boolean
  hintVisible: boolean
  retryEnabled: boolean
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
  private pauseReturnFocus: HTMLElement | null = null
  private rulesReturnFocus: HTMLElement | null = null
  private rulesReturnToPause = false
  private onlinePauseMode = false

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
      const dialog = this.root.querySelector<HTMLElement>('.modal[aria-modal="true"].is-active')
      if (!dialog) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (dialog.dataset.modal === 'settings') this.modal(null)
        else if (dialog.dataset.modal === 'rule-hint') this.handlers.action('rulehint:close', dialog.querySelector<HTMLElement>('[data-action="rulehint:close"]')!)
        else if (dialog.dataset.modal === 'tutorial-prompt') this.handlers.action('tutorial:skip-prompt', dialog.querySelector<HTMLElement>('[data-action="tutorial:skip-prompt"]')!)
        else if (dialog.dataset.modal === 'tutorial-done') this.handlers.action('tutorial:done-menu', dialog.querySelector<HTMLElement>('[data-action="tutorial:done-menu"]')!)
        else if (dialog.dataset.modal === 'pause') this.handlers.action('resume', dialog.querySelector<HTMLElement>('[data-action="resume"]')!)
        else if (dialog.dataset.modal === 'rules') this.modal(null)
        return
      }
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
    if (name === 'pause' && !current) this.pauseReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (name === 'rules') {
      this.rulesReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      this.rulesReturnToPause = current?.dataset.modal === 'pause'
    }
    for (const s of this.$$('[data-modal]')) {
      const active = s.dataset.modal === name
      s.classList.toggle('is-active', active)
      s.setAttribute('aria-hidden', String(!active))
    }
    this.root.classList.toggle('has-modal', name !== null)
    if (name === 'settings') {
      this.$('[data-modal="settings"] [data-setting-switch]:not([disabled])').focus()
    } else if (name === 'pause') {
      this.$('[data-modal="pause"] [data-action="resume"]').focus()
    } else if (name === 'rules') {
      this.$('[data-modal="rules"] [data-action="closemodal"]').focus()
    } else if (name === null && current?.dataset.modal === 'settings') {
      const target = this.settingsReturnFocus
      this.settingsReturnFocus = null
      if (target?.isConnected) target.focus()
    } else if (name === null && current?.dataset.modal === 'pause') {
      const target = this.pauseReturnFocus
      this.pauseReturnFocus = null
      if (target?.isConnected) target.focus()
    } else if (name === null && current?.dataset.modal === 'rules') {
      const restorePause = this.rulesReturnToPause
      const target = this.rulesReturnFocus
      this.rulesReturnToPause = false
      this.rulesReturnFocus = null
      if (restorePause) {
        const pauseReturnFocus = this.pauseReturnFocus
        this.modal('pause')
        this.pauseReturnFocus = pauseReturnFocus
        this.$('[data-modal="pause"] [data-action="rules"]').focus()
      } else if (target?.isConnected) target.focus()
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

  setAimPower(aim: { power: number; valid: boolean; capped: boolean } | null): void {
    const panel = this.$('[data-aim-power]')
    panel.hidden = aim === null
    if (!aim) return
    const power = Math.max(0, Math.min(1, Number.isFinite(aim.power) ? aim.power : 0))
    const level = !aim.valid ? 'pull' : aim.capped || power >= 0.9 ? 'max' : power < 0.34 ? 'low' : power < 0.67 ? 'medium' : 'high'
    const percent = Math.round(power * 100)
    const labels: Record<string, string> = { pull: 'Pull back', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }
    panel.dataset.level = level
    panel.querySelector<HTMLElement>('[data-aim-level]')!.textContent = labels[level]
    const meter = panel.querySelector<HTMLElement>('[role="meter"]')!
    meter.setAttribute('aria-valuenow', String(percent))
    meter.setAttribute('aria-valuetext', `${labels[level]}, ${percent} percent`)
    panel.querySelector<HTMLElement>('[data-aim-bar]')!.style.width = `${percent}%`
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

  setTutorialCoach(view: TutorialCoachView | null): void {
    const panel = this.$('[data-tutorial-coach]')
    const wasHidden = panel.hidden
    panel.hidden = view === null
    this.root.classList.toggle('tutorial-active', view !== null)
    this.root.classList.toggle('tutorial-hide-combo', view !== null && view.stepIndex < 4)
    this.setTutorialPauseMode(view !== null)
    if (!view) return
    panel.querySelector<HTMLElement>('[data-tutorial-step]')!.textContent = view.stepLabel
    panel.querySelector<HTMLElement>('[data-tutorial-title]')!.textContent = view.title
    panel.querySelector<HTMLElement>('[data-tutorial-copy]')!.textContent = view.copy
    const status = panel.querySelector<HTMLElement>('[data-tutorial-status]')!
    status.textContent = view.status
    status.hidden = !view.status
    const hint = panel.querySelector<HTMLElement>('[data-tutorial-hint]')!
    hint.textContent = view.hint
    hint.hidden = !view.hintVisible
    panel.querySelector<HTMLButtonElement>('[data-action="tutorial:hint"]')!.hidden = !view.hintAvailable
    panel.querySelector<HTMLButtonElement>('[data-action="tutorial:retry"]')!.disabled = !view.retryEnabled
    panel.querySelector<HTMLButtonElement>('[data-action="tutorial:skip"]')!.disabled = !view.retryEnabled
    if (wasHidden && this.root.dataset.current === 'hud') panel.querySelector<HTMLElement>('[data-tutorial-title]')!.focus()
  }

  setTutorialPauseMode(enabled: boolean): void {
    this.$('[data-tutorial-leave]').hidden = !enabled
    this.$('[data-pause-newmatch]').hidden = enabled || this.onlinePauseMode
    this.$('[data-pause-concede]').hidden = enabled || this.onlinePauseMode
    const restart = this.$('[data-pause-restart]')
    restart.textContent = enabled ? 'Retry drill' : 'Restart'
  }

  setOnlinePauseMode(enabled: boolean): void {
    this.onlinePauseMode = enabled
    this.$('[data-local-restart]').hidden = enabled
    this.$('[data-online-copy]').hidden = !enabled
    this.$('[data-online-leave]').hidden = !enabled
    this.setTutorialPauseMode(!this.$('[data-tutorial-leave]').hidden)
  }

  showRuleHint(view: RuleHintContent): void {
    const modal = this.$('[data-modal="rule-hint"]')
    modal.dataset.ruleHintKey = view.key
    modal.querySelector<HTMLElement>('[data-rule-hint-title]')!.textContent = view.label
    modal.querySelector<HTMLElement>('[data-rule-hint-why]')!.textContent = view.why
    modal.querySelector<HTMLElement>('[data-rule-hint-restart]')!.textContent = view.restart
    modal.querySelector<HTMLElement>('[data-rule-hint-restriction]')!.textContent = view.restriction
    this.modal('rule-hint')
    modal.querySelector<HTMLButtonElement>('[data-action="rulehint:close"]')!.focus()
  }

  showTutorialPrompt(): void {
    this.modal('tutorial-prompt')
    this.$('[data-action="tutorial:learn"]').focus()
  }

  showTutorialComplete(): void {
    this.modal('tutorial-done')
    this.$('[data-action="tutorial:regular"]').focus()
  }

  showMatchSummary(view: MatchSummaryView, actions: string): void {
    const modal = this.$('[data-modal="winner"]')
    modal.style.setProperty('--team', view.color)
    modal.querySelector<HTMLElement>('[data-summary-title]')!.textContent = view.headline
    modal.querySelector<HTMLElement>('[data-summary-mode]')!.textContent = view.mode
    modal.querySelector<HTMLElement>('[data-summary-duration]')!.textContent = view.duration
    modal.querySelector<HTMLElement>('[data-summary-label]')!.textContent = view.scoreLabel
    modal.setAttribute('aria-label', `${view.headline}. ${view.teams[0]} ${view.score[0]}, ${view.teams[1]} ${view.score[1]}.`)
    for (const team of [0, 1] as const) {
      modal.querySelector<HTMLElement>(`[data-summary-team="${team}"]`)!.textContent = view.teams[team]
      modal.querySelector<HTMLElement>(`[data-summary-column="${team}"]`)!.textContent = view.teams[team]
      modal.querySelector<HTMLElement>(`[data-summary-score="${team}"]`)!.textContent = String(view.score[team])
    }
    const body = modal.querySelector<HTMLTableSectionElement>('[data-summary-stats]')!
    body.replaceChildren(...view.stats.map(stat => {
      const row = document.createElement('tr')
      const label = document.createElement('th')
      label.scope = 'row'
      label.textContent = stat.label
      row.append(label)
      for (const value of stat.values) {
        const cell = document.createElement('td')
        cell.textContent = String(value)
        row.append(cell)
      }
      return row
    }))
    const replay = modal.querySelector<HTMLButtonElement>('[data-summary-replay]')!
    replay.hidden = !view.replayAvailable
    this.html('[data-win-actions]', actions)
    this.modal('winner')
    ;(view.replayAvailable ? replay : modal.querySelector<HTMLButtonElement>('[data-win-actions] button'))?.focus()
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
  <header class="scorebar" aria-label="Match scoreboard">
    <div class="slip" data-team-slip="0"><span class="slip-cap"></span><span class="slip-name"></span><span class="slip-score">0</span></div>
    <div class="mid">
      <div class="clock" data-clock hidden aria-label="Match clock">0:00</div>
      <div class="turn" data-turn role="status" aria-live="polite" aria-atomic="true"><span class="turn-who"></span><span class="turn-what"></span></div>
    </div>
    <div class="slip right" data-team-slip="1"><span class="slip-score">0</span><span class="slip-name"></span><span class="slip-cap"></span></div>
  </header>
  <div class="meters" data-meters></div>
  <nav class="hud-tools" aria-label="Match controls">
    <button class="tool tool-pause" type="button" data-action="pause" aria-label="Open match pause menu" title="Pause match">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>Pause</span>
    </button>
  </nav>
  <aside class="aim-power" data-aim-power hidden aria-live="off">
    <div class="aim-power-head"><span>Flick pull</span><strong data-aim-level>Pull back</strong></div>
    <div class="aim-power-track" role="meter" aria-label="Flick pull power" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Pull back, 0 percent"><span data-aim-bar></span></div>
  </aside>
  <div class="powerbtn-slot" data-powerbtn></div>
  <button class="replay-tag" data-replay data-action="skipreplay" hidden>REPLAY <small>tap to skip</small></button>
</section>

<aside class="tutorial-coach" data-tutorial-coach hidden aria-label="CAPBALL tutorial" aria-live="polite">
  <div class="tutorial-coach-head"><span class="tutorial-step" data-tutorial-step></span><h2 tabindex="-1" data-tutorial-title></h2></div>
  <p data-tutorial-copy></p>
  <p class="tutorial-status" data-tutorial-status hidden role="status"></p>
  <p class="tutorial-hint" data-tutorial-hint hidden></p>
  <div class="tutorial-actions">
    <button class="chip" data-action="tutorial:hint" hidden>Need a hint?</button>
    <button class="chip" data-action="tutorial:retry" disabled>Retry drill</button>
    <button class="chip" data-action="tutorial:skip" disabled>Skip drill</button>
    <button class="chip" data-action="tutorial:pause">Pause</button>
  </div>
</aside>

<div class="banner" data-banner></div>
<div class="caption" data-caption></div>
<div class="restart-banner" data-restart-banner aria-live="polite"></div>
<div class="penalty-timer" data-penalty-timer hidden aria-live="polite"></div>

<div class="modal" data-modal="rules" role="dialog" aria-modal="true" aria-labelledby="rules-title" aria-hidden="true">
  <div class="sheet">
    <div class="tape tape-b"></div>
    <h2 id="rules-title">How to play</h2>
    <div class="rules-body" data-rules-body></div>
  <button class="btn" data-action="closemodal">Got it</button>
  </div>
</div>

<div class="modal" data-modal="tutorial-prompt" role="dialog" aria-modal="true" aria-labelledby="tutorial-prompt-title" aria-hidden="true">
  <div class="sheet tutorial-sheet">
    <div class="tape tape-b"></div>
    <span class="kicker">First match?</span>
    <h2 id="tutorial-prompt-title">Learn the feel</h2>
    <p>A short, optional solo practice teaches flicking, rebounds and pass chains. It uses real CAPBALL physics; you can leave whenever you like.</p>
    <div class="win-actions">
      <button class="btn" data-action="tutorial:learn">Learn the basics</button>
      <button class="btn ghost" data-action="tutorial:skip-prompt">Skip and play</button>
    </div>
  </div>
</div>

<div class="modal" data-modal="tutorial-done" role="dialog" aria-modal="true" aria-labelledby="tutorial-done-title" aria-hidden="true">
  <div class="sheet tutorial-sheet">
    <div class="tape tape-b"></div>
    <span class="kicker">Practice complete</span>
    <h2 id="tutorial-done-title">Now take it to the street</h2>
    <p>You’ve felt the flick, the boards, the pass chain and the different caps. Your normal matches still use the full rules.</p>
    <div class="win-actions">
      <button class="btn" data-action="tutorial:regular">Start Quick Match</button>
      <button class="btn ghost" data-action="tutorial:done-replay">Replay tutorial</button>
      <button class="chip" data-action="tutorial:done-menu">Back to menu</button>
    </div>
  </div>
</div>

<div class="modal" data-modal="rule-hint" role="dialog" aria-modal="true" aria-labelledby="rule-hint-title" aria-hidden="true">
  <div class="sheet referee-sheet">
    <div class="tape tape-b"></div>
    <span class="kicker">Referee’s call</span>
    <h2 id="rule-hint-title" data-rule-hint-title></h2>
    <dl class="referee-details">
      <div><dt>Why</dt><dd data-rule-hint-why></dd></div>
      <div><dt>Restart</dt><dd data-rule-hint-restart></dd></div>
      <div><dt>Remember</dt><dd data-rule-hint-restriction></dd></div>
    </dl>
    <button class="btn" data-action="rulehint:close">Got it</button>
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

<div class="modal" data-modal="winner" role="dialog" aria-modal="true" aria-labelledby="summary-title" aria-hidden="true">
  <div class="sheet win match-summary">
    <div class="tape tape-a"></div>
    <p class="win-kicker">Full time <span class="summary-mode" data-summary-mode></span></p>
    <h2 class="win-title" id="summary-title" data-summary-title></h2>
    <div class="summary-score" aria-label="Final score">
      <div class="summary-side"><span data-summary-team="0"></span><strong data-summary-score="0">0</strong></div>
      <span class="summary-divider" aria-hidden="true">–</span>
      <div class="summary-side"><span data-summary-team="1"></span><strong data-summary-score="1">0</strong></div>
    </div>
    <p class="summary-score-label" data-summary-label>Final score</p>
    <p class="summary-duration">Match time <strong data-summary-duration>0:00</strong></p>
    <table class="summary-stats" aria-label="Match statistics">
      <thead><tr><th scope="col">Match stats</th><th scope="col" data-summary-column="0"></th><th scope="col" data-summary-column="1"></th></tr></thead>
      <tbody data-summary-stats></tbody>
    </table>
    <button class="btn ghost summary-replay" data-action="replay-last-goal" data-summary-replay hidden>Replay last goal</button>
    <div class="win-actions" data-win-actions></div>
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

<div class="modal pause-modal" data-modal="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title" aria-hidden="true">
  <div class="sheet pause-sheet">
    <span class="pause-kicker">Match paused</span>
    <h2 id="pause-title">Take a breather</h2>
    <p class="pause-intro">The pitch is waiting. Resume when you’re ready, or open a match tool below.</p>
    <button class="btn pause-resume" type="button" data-action="resume">Resume match</button>
    <div class="pause-actions" aria-label="Match tools">
      <button class="btn ghost" type="button" data-action="restart" data-pause-restart data-local-restart>Restart</button>
      <button class="btn ghost" type="button" data-action="rules">Rules</button>
      <button class="btn ghost pause-sound" type="button" data-action="sound" aria-pressed="true"><span class="lbl">Sound on</span></button>
      <button class="btn ghost" type="button" data-action="newmatch" data-pause-newmatch title="Leave this match and return to the main menu">New match</button>
      <button class="btn ghost" type="button" data-action="online-copy" data-online-copy hidden>Invite link</button>
      <button class="btn ghost" type="button" data-action="online-leave" data-online-leave hidden>Leave room</button>
      <button class="btn ghost tool-tune" type="button" data-action="tune" title="Developer tuning overlay" data-tune-btn hidden>Tuning tools</button>
      <button class="btn ghost" type="button" data-action="tutorial:leave" data-tutorial-leave hidden>Save &amp; leave tutorial</button>
    </div>
    <button class="btn ghost pause-concede" type="button" data-action="concede-match" data-pause-concede>Concede match</button>
  </div>
</div>
`
