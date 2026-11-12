import { Audio } from './audio/audio'
import { Commentator, Voice } from './audio/commentary'
import type { CallKind, CallVars } from './audio/commentary'
import { Crowd } from './audio/crowd'
import { getOnlineProfile, INVITE_PROFILE, TUTORIAL_RULESET } from './config/rulesets'
import type { Ruleset } from './config/rulesets'
import { AI, BALL, CAP_TYPES, FX, INPUT, PITCH, SURFACES, SURFACE_IDS } from './config/tuning'
import { FOOTBALL } from './config/football'
import type { AiLevel, SurfaceId } from './config/tuning'
import { AiBrain, captureBoard } from './ai/brain'
import type { Decision } from './ai/brain'
import { Particles, Shake } from './fx/effects'
import { Match } from './game/match'
import { newPossession } from './game/play'
import type { Outcome, TrackerEvent, Whistle } from './game/play'
import { HiddenPenalty, legalKeeperPosition } from './game/penalty'
import { ReplayRecorder } from './game/replay'
import type { ReplayClip } from './game/replay'
import { RenderInterpolator } from './net/smoothing'
import type { Pose } from './net/smoothing'
import { MatchStatistics } from './game/summary'
import { TutorialProgress, TUTORIAL_COMPLETE_STEP, TUTORIAL_STEPS } from './game/tutorial'
import { makeRuleHint } from './game/ruleHints'
import type { RuleHintKey } from './game/ruleHints'
import { AI_RIVAL_CREWS, RIVAL_CREWS, Tournament, simulateAiTie } from './game/tournament'
import type { Tie } from './game/tournament'
import type { TurnReason } from './game/turns'
import { TuneOverlay, activeOverlays } from './debug/overlay'
import { FlickInput, activeInputHandlers } from './input/flick'
import { KeeperDragInput, RuleGestureGuard, activePenaltyInputHandlers } from './input/penalty'
import type { FlickAim } from './input/flick'
import type { Contact, TeamIndex, Vec } from './physics/world'
import type { TeamDesign } from './render/capArt'
import { Renderer } from './render/renderer'
import type { CapView, FrameState } from './render/renderer'
import { defaultTeam, loadSettings, sanitizeTeam, saveSettings } from './store/settings'
import type { Settings } from './store/settings'
import { drawPreviews, editorHtml, resolveKits } from './ui/editor'
import { buildRuleset, setupHtml } from './ui/setup'
import { UI, esc } from './ui/ui'
import type { MatchSummaryView, TutorialCoachView } from './ui/ui'
import { OnlineClient, ONLINE_NOT_CONFIGURED, probeOnlineConfig } from './net/client'
import type { LinkState } from './net/client'
import { penaltyCommitText, randomNonce, sha256Hex } from './net/protocol'
import type { FlickMessage, NetworkPenalty, NetworkState, PenaltyChoice, PenaltyShotMessage, ServerMessage } from './net/protocol'

export const TURN_LABEL: Record<TurnReason, string> = {
  kickoff: 'kick off', normal: 'your flick', bonus: 'BONUS FLICK!', freekick: 'free kick', penalty: 'penalty!',
  corner: 'corner', goalkick: 'goal kick', dropball: 'dropped ball', offside: 'free kick (offside)', halftime: 'second half',
  keeper: 'slide your keeper', shootout: 'take the penalty',
}

/** Street-zine cup: fat marker outline, printed gradient and a hand-cut star. */
const CUP_TROPHY_SVG = `<svg class="cup-svg" viewBox="0 0 220 240" role="img" aria-label="The CAPBALL street cup" focusable="false">
  <defs>
    <linearGradient id="cup-shine" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd23f"/><stop offset=".55" stop-color="#ff8a1f"/><stop offset="1" stop-color="#e8262b"/>
    </linearGradient>
  </defs>
  <g stroke="var(--ink)" stroke-width="7" stroke-linejoin="round" stroke-linecap="round">
    <path d="M70 28h80v40c0 31-18 54-40 54s-40-23-40-54z" fill="url(#cup-shine)"/>
    <path d="M70 40H44c0 34 12 50 34 52" fill="none"/>
    <path d="M150 40h26c0 34-12 50-34 52" fill="none"/>
    <path d="M97 122h26v26H97z" fill="var(--cap)"/>
    <path d="M76 148h68l9 24H67z" fill="var(--paper2)"/>
    <path d="M84 172h52v16H84z" fill="var(--ink)"/>
    <path d="M62 210h96" fill="none"/>
  </g>
  <path d="M110 42l7 15 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2z" fill="var(--paper)" stroke="var(--ink)" stroke-width="5" stroke-linejoin="round"/>
</svg>`

type Mode = 'quick' | 'ai' | 'shootout' | 'tournament' | 'online' | 'tutorial'

interface ReplayState { clip: ReplayClip; t: number; returnToSummary?: boolean }

export class App {
  readonly canvas: HTMLCanvasElement
  readonly renderer: Renderer
  readonly ui: UI
  readonly audio = new Audio()
  readonly crowd = new Crowd(this.audio)
  readonly commentator = new Commentator()
  readonly voice = new Voice()
  readonly particles = new Particles()
  readonly shake = new Shake()
  readonly input: FlickInput
  readonly keeperInput: KeeperDragInput
  readonly ruleGestureGuard: RuleGestureGuard
  readonly tune: TuneOverlay
  settings: Settings
  private readonly debugToolsEnabled: boolean
  match: Match | null = null
  ruleset: Ruleset
  mode: Mode = 'quick'
  /** Crews in the current match (tournament crews or the two designs, kit-resolved). */
  teams: [TeamDesign, TeamDesign]
  tournament: Tournament | null = null
  private currentTie: Tie | null = null
  /** Tied tournament match waiting for its shootout. */
  private pendingTie: { tie: Tie; goals: [number, number] } | null = null
  /** Versus-AI bracket: human is crew 0, AI-only fixtures resolve deterministically. */
  private aiTournament = false
  private tournamentSeed = 1
  private tournamentRules: Ruleset | null = null
  private aim: FlickAim | null = null
  private aiBrain: AiBrain | null = null
  private aiEpoch = 0
  private aiThinkMs = 0
  private aiDragMs = 0
  private aiKeeperMs = 0
  private penaltyAiMs = 0
  private aiBusy = false
  private aiDecision: Decision | null = null
  private onlineClient: OnlineClient | null = null
  private onlineState: NetworkState | null = null
  private onlineTeam: TeamIndex | null = null
  private readonly pendingOnlineActions = new Set<number>()
  private lastOnlineGoalSeq = 0
  private matchUnsubs: (() => void)[] = []
  private recorder: ReplayRecorder | null = null
  private replay: ReplayState | null = null
  private readonly matchStatistics = new MatchStatistics()
  private lastGoalReplay: ReplayClip | null = null
  private matchSummary: MatchSummaryView | null = null
  private summaryActions = ''
  private tutorialGuide: TutorialProgress | null = null
  private tutorialStageSignature = ''
  private tutorialTarget: Vec | null = null
  private tutorialPickCapId: number | null = null
  private lastRuleWhistle: Whistle | null = null
  private pendingRuleHint: RuleHintKey | null = null
  private goalHoldMs = -1
  private goalMark = 0
  private raf = 0
  private last = 0
  private clockText = ''
  private crowdTimer = 0
  private editorReturn: 'setup' | 'start' = 'start'
  private abort = new AbortController()
  private resizeObs: ResizeObserver
  private live = false
  private hiddenPenalty: HiddenPenalty | null = null
  private penaltyRevealTimer = 0
  private penaltyTimerSecond = -1
  private onlinePenaltyId = -1
  private onlinePenaltyRole: 'keeper' | 'shot' | null = null
  private onlinePenaltySeal: { choice: PenaltyChoice; nonce: string; commit: string } | null = null
  private onlinePenaltyCommitted = false
  private onlinePenaltyRevealSent = false
  private onlinePenaltyStage: 'commit' | 'reveal' | null = null
  /** Render-only settle for authoritative online corrections; never touches match physics. */
  private readonly onlineSmoother = new RenderInterpolator()
  private onlineDiagMs = 0
  private restartZone: { kind: Outcome['kind']; team: TeamIndex; at: Vec | null; end: 0 | 1 | null; retake: boolean } | null = null
  private confirmAction: 'concede' | null = null

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas
    this.debugToolsEnabled = import.meta.env.DEV || new URLSearchParams(window.location.search).get('debug') === '1'
    this.settings = loadSettings()
    this.teams = resolveKits(this.settings.teams[0], this.settings.teams[1])
    this.ruleset = buildRuleset(this.settings.ruleset, this.settings.flags, this.settings.penaltyTimeout)
    this.renderer = new Renderer(canvas, this.teams)
    this.applyTheme()
    this.renderer.layers.push(ctx => this.drawRestartZone(ctx))
    this.renderer.layers.push(ctx => this.particles.draw(ctx, [0]))
    this.renderer.overLayers.push(ctx => this.particles.draw(ctx, [1, 2]))
    this.renderer.overLayers.push(ctx => this.tune.drawWorld(ctx, this.renderer.view))
    this.renderer.overLayers.push(ctx => this.drawOutMark(ctx))
    this.renderer.overLayers.push(ctx => this.drawTutorialTarget(ctx))
    this.ui = new UI(uiRoot, { action: (a, el) => this.onAction(a, el) })
    this.onlineClient = new OnlineClient({
      status: (state, detail) => this.onOnlineStatus(state, detail),
      message: message => this.onOnlineMessage(message),
      lost: () => { if (this.mode === 'online' && this.match) this.match.paused = true },
    })
    this.tune = new TuneOverlay(document.body)
    this.tune.onLayout = () => this.resize()
    this.setTuning(this.settings.tuning)
    this.input = new FlickInput(canvas, this.renderer.view, {
      pickable: () => this.pickable(),
      onAim: a => this.onAim(a),
      onFlick: (id, dir, power, spin) => { this.commitFlick(id, dir, power, spin) },
      spinEnabled: () => !!this.match?.ruleset.spin,
    })
    this.input.attach()
    this.keeperInput = new KeeperDragInput(canvas, this.renderer.view, {
      target: () => this.keeperDragTarget(),
      onMove: p => this.movePenaltyKeeper(p),
    })
    this.keeperInput.attach()
    this.ruleGestureGuard = new RuleGestureGuard(canvas, this.renderer.view,
      () => this.localRuleInputActive(),
      at => { this.input.cancel(); this.keeperInput.cancel(); this.match?.awardInputFoul(at) },
    )
    this.ruleGestureGuard.attach()
    this.audio.setEnabled(this.settings.sound)
    this.audio.onReady = () => { if (this.settings.sound) this.crowd.start() }
    if (!this.voice.available) this.settings.speech = false
    this.voice.enabled = this.settings.speech
    this.ui.setSound(this.settings.sound)
    this.syncSettingsPanel()
    this.renderStartMenu()
    this.ui.show('start')

    const unlock = () => this.audio.unlock()
    window.addEventListener('pointerdown', unlock, { signal: this.abort.signal })
    window.addEventListener('keydown', unlock, { signal: this.abort.signal })
    // Tap anywhere on the pitch skips a replay.
    canvas.addEventListener('pointerdown', () => { if (this.replay) this.endReplay() }, { signal: this.abort.signal })
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.voice.stop() }, { signal: this.abort.signal })
    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(document.documentElement)
    this.resize()
    // A demo match sits behind the menus so the pitch is visible.
    this.startMatch(this.ruleset, this.surface, { live: false })
    this.raf = requestAnimationFrame(t => this.frame(t))
  }

  get surface(): SurfaceId {
    return (this.settings.surface in SURFACES ? this.settings.surface : 'park') as SurfaceId
  }

  private renderStartMenu(): void {
    const tutorialLabel = this.settings.tutorialStep >= TUTORIAL_COMPLETE_STEP ? 'Replay tutorial' : this.settings.tutorialStep > 0 ? 'Resume tutorial' : 'Learn CAPBALL'
    this.ui.html('[data-start-menu]', `
      <div class="start-main-actions" role="group" aria-label="Main game modes">
        <button class="btn menu-main menu-primary" data-main-mode="quick" data-action="mode:quick">Quick Match</button>
        <button class="btn ghost menu-main" data-main-mode="design" data-action="editor">
          <svg class="menu-cap-icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="13"/><circle class="cap-inner" cx="16" cy="16" r="8"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5M6.8 6.8l3.6 3.6M21.6 21.6l3.6 3.6M25.2 6.8l-3.6 3.6M10.4 21.6l-3.6 3.6"/></svg>
          Design Your Caps
        </button>
        <button class="btn ghost menu-main" data-main-mode="shootout" data-action="mode:shootout">Penalty Shootout</button>
        <button class="btn ghost menu-main" data-main-mode="tournament" data-action="mode:tournament">Street Tournament</button>
      </div>
      <div class="start-utility">
        <button class="chip invite-entry" type="button" data-action="mode:online" data-invite-entry>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="8" r="3.4"/><path d="M3 19.5c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5"/><path d="M18.5 8v6M15.5 11h6"/></svg>
          Invite a Mate
        </button>
        <details class="start-more">
          <summary>Other modes &amp; help</summary>
          <div class="start-more-actions">
            <button class="chip" data-action="tutorial:entry">${tutorialLabel}</button>
            <button class="chip" data-action="rules">How to play</button>
            <button class="chip" data-action="mode:ai">Play the AI</button>
          </div>
        </details>
      </div>`)
  }

  private startTutorial(replayFromStart = false): void {
    this.mode = 'tutorial'
    this.tournament = null
    this.currentTie = null
    this.pendingTie = null
    if (replayFromStart) this.settings.tutorialStep = 0
    this.settings.tutorialPrompted = true
    saveSettings(this.settings)
    this.tutorialGuide = new TutorialProgress(this.settings.tutorialStep)
    this.tutorialStageSignature = ''
    this.startMatch(TUTORIAL_RULESET, 'park')
    this.syncTutorialCoach()
  }

  private skipTutorialPrompt(): void {
    this.settings.tutorialPrompted = true
    saveSettings(this.settings)
    this.mode = 'quick'
    this.ui.modal(null)
    this.openSetup()
  }

  private leaveTutorial(): void {
    if (this.tutorialGuide) this.settings.tutorialStep = this.tutorialGuide.step
    saveSettings(this.settings)
    this.tutorialGuide = null
    this.tutorialStageSignature = ''
    this.mode = 'quick'
    this.toMenu()
  }

  private finishTutorial(): void {
    const guide = this.tutorialGuide
    const m = this.match
    if (!guide?.complete || !m || m.phase !== 'aim' || !m.world.isAtRest()) return
    this.settings.tutorialStep = TUTORIAL_COMPLETE_STEP
    saveSettings(this.settings)
    this.ui.setTutorialCoach(null)
    this.ui.showTutorialComplete()
  }

  private tutorialProgressChanged(): void {
    const guide = this.tutorialGuide
    if (!guide) return
    this.settings.tutorialStep = guide.step
    saveSettings(this.settings)
    this.syncTutorialCoach()
    if (guide.complete) this.ui.caption('Practice complete · let the play settle for a moment.', 1800)
  }

  private retryTutorialDrill(): void {
    const guide = this.tutorialGuide
    const m = this.match
    if (this.mode !== 'tutorial' || !guide || guide.complete || !m || m.phase !== 'aim' || !m.world.isAtRest() || this.ui.modalOpen) return
    guide.retry()
    this.tutorialStageSignature = ''
    if (guide.step < 3) {
      // The opening controls drills use the real kickoff formation and reset only at rest.
      m.restart()
      return
    }
    this.stageTutorialScenario()
    this.syncTutorialCoach()
  }

  private skipTutorialDrill(): void {
    const guide = this.tutorialGuide
    const m = this.match
    if (this.mode !== 'tutorial' || !guide || guide.complete || !m || m.phase !== 'aim' || !m.world.isAtRest() || this.ui.modalOpen) return
    if (!guide.skip()) return
    this.tutorialStageSignature = ''
    this.tutorialProgressChanged()
    if (guide.complete) this.finishTutorial()
    else if (guide.step >= 3) this.stageTutorialScenario()
  }

  private syncTutorialCoach(): void {
    const guide = this.tutorialGuide
    if (this.mode !== 'tutorial' || !guide || guide.complete) {
      this.ui.setTutorialCoach(null)
      return
    }
    const m = this.match
    const snapshot = guide.snapshot()
    const step = TUTORIAL_STEPS[snapshot.step]
    const settled = !!m && m.phase === 'aim' && m.world.isAtRest() && !this.ui.modalOpen
    let copy: string = step.copy
    let status = ''
    if (snapshot.step === 1) status = `Short pull ${snapshot.shortPullSeen ? '✓' : '○'} · longer pull ${snapshot.longPullSeen ? '✓' : '○'}. Compare the arrow and meter.`
    if (snapshot.step === 2 && m?.phase === 'moving') status = 'Ball still moving · your next turn unlocks when every piece settles.'
    if (snapshot.step === 3 && snapshot.boardPhase === 'bonus') {
      copy = 'The rebound is in play. On this fresh attempt, guide that real rebound onto one of your caps to earn a bonus flick.'
      status = 'Rebound lesson complete · now earn the bonus.'
    }
    if (snapshot.step === 4) {
      copy = 'Flick the ball into a different friendly cap. Three real completed passes charge a power shot; the combo meter is now visible.'
      status = `${snapshot.passes} of 3 passes · each drill resets only after the play settles.`
    }
    if (snapshot.step === 6) {
      const next = snapshot.capTypes.includes('winger') ? 'striker' : 'winger'
      const label = next === 'winger' ? 'Winger' : 'Striker'
      copy = `Try the highlighted ${label.toLowerCase()} cap, then compare the other type. They have different weight and glide.`
      status = `${snapshot.capTypes.length} of 2 cap types tried · this is optional.`
    }
    if (snapshot.step === 2 && m?.phase !== 'moving') status = 'Take a flick, then wait for the full play to settle.'
    const view: TutorialCoachView = {
      stepIndex: snapshot.step,
      stepLabel: snapshot.step === 6 ? 'OPTIONAL · CAP COMPARISON' : `LESSON ${snapshot.step + 1} OF ${TUTORIAL_STEPS.length}`,
      title: step.title,
      copy,
      status,
      hint: step.hint,
      hintAvailable: snapshot.attempts >= 2,
      hintVisible: snapshot.hintVisible,
      retryEnabled: settled,
    }
    this.ui.setTutorialCoach(view)
  }

  private tutorialCapId(type: string): number {
    const m = this.match
    if (!m) return 0
    const found = m.world.caps.findIndex((_cap, id) => {
      const info = m.world.capInfo(id)
      return info.team === 0 && info.type.id === type
    })
    return found >= 0 ? found : 0
  }

  /** Reposition only between settled practice plays; every flick/rebound/pass stays physical. */
  private stageTutorialScenario(): void {
    const m = this.match
    const guide = this.tutorialGuide
    if (!m || !guide || guide.complete || m.phase !== 'aim' || !m.world.isAtRest() || this.ui.modalOpen) return
    const state = guide.snapshot()
    const signature = `${state.step}:${state.boardPhase}:${state.passes}:${state.attempts}:${state.capTypes.join(',')}`
    if (signature === this.tutorialStageSignature) return

    // Park both teams clear of the drill lane; no body moves during a live play.
    for (let id = 0; id < m.world.caps.length; id++) {
      const team = m.world.capInfo(id).team
      const slot = m.world.capInfo(id).slot
      m.world.place(m.world.caps[id], { x: 110 + slot * 195, y: team === 0 ? 470 : 540 })
    }
    this.tutorialTarget = null
    this.tutorialPickCapId = null

    if (state.step <= 2) {
      const sourceId = this.tutorialCapId('striker')
      const source = m.world.caps[sourceId]
      const sourceRadius = m.world.capInfo(sourceId).type.radius
      const sourceX = 280
      const sourceY = 480
      for (let id = 0; id < m.world.caps.length; id++) {
        if (id === sourceId) continue
        const info = m.world.capInfo(id)
        m.world.place(m.world.caps[id], { x: 110 + info.slot * 195, y: info.team === 0 ? 560 : 80 })
      }
      m.world.place(source, { x: sourceX, y: sourceY })
      m.world.place(m.world.ball, { x: sourceX + sourceRadius + BALL.radius + 4, y: sourceY })
      this.tutorialTarget = { x: 1000, y: PITCH.height / 2 }
      this.tutorialPickCapId = sourceId
      m.possession = newPossession()
    } else if (state.step === 3) {
      const sourceId = this.tutorialCapId('striker')
      const targetId = this.tutorialCapId('winger')
      const source = m.world.caps[sourceId]
      const sourceRadius = m.world.capInfo(sourceId).type.radius
      const ballX = 739
      const ballY = 75
      m.world.place(source, { x: ballX - sourceRadius - BALL.radius - 3, y: ballY })
      m.world.place(m.world.caps[targetId], { x: 872, y: 161 })
      m.world.place(m.world.ball, { x: ballX, y: ballY })
      // The marked winger lies on the return path, not the outbound path to the end board.
      this.tutorialTarget = { x: 872, y: 161 }
      this.tutorialPickCapId = sourceId
      m.possession = newPossession()
    } else if (state.step === 4 || state.step === 5 || state.step === 6) {
      if (state.step === 4 && state.passes === 0) m.possession = newPossession()
      if (state.step === 5) {
        m.possession.chain[0] = m.ruleset.combos.passesForPowerShot
        m.possession.powerReady[0] = true
      }
      const wantedType = state.step === 6
        ? (state.capTypes.includes('winger') ? 'striker' : 'winger')
        : state.step === 5 ? 'striker' : null
      const previous = state.step === 4 && state.passes > 0 ? m.possession.lastCap : null
      const sourceId = previous?.team === 0 ? previous.id : wantedType ? this.tutorialCapId(wantedType) : this.tutorialCapId('striker')
      const sourceInfo = m.world.capInfo(sourceId)
      const nextSlot = (sourceInfo.slot + 1) % 5
      const targetId = nextSlot
      const sourceX = state.step === 4 ? 175 + state.passes * 160 : 210
      const sourceY = 310
      const sourceRadius = sourceInfo.type.radius
      const ballX = sourceX + sourceRadius + BALL.radius + 4
      const targetX = state.step === 4 ? ballX + 118 : 910
      const targetY = state.step === 4 ? sourceY : 310
      m.world.place(m.world.caps[sourceId], { x: sourceX, y: sourceY })
      if (state.step === 4) m.world.place(m.world.caps[targetId], { x: targetX, y: targetY })
      m.world.place(m.world.ball, { x: ballX, y: sourceY })
      this.tutorialTarget = state.step === 6 ? { x: sourceX, y: sourceY } : { x: targetX, y: targetY }
      this.tutorialPickCapId = sourceId
    }

    this.tutorialStageSignature = signature
    this.refreshMeters()
    this.syncTutorialCoach()
  }

  private drawTutorialTarget(ctx: CanvasRenderingContext2D): void {
    const p = this.tutorialTarget
    if (!p || this.mode !== 'tutorial') return
    ctx.save()
    ctx.strokeStyle = '#ffd34f'
    ctx.fillStyle = 'rgba(255, 211, 79, .12)'
    ctx.lineWidth = 5
    ctx.setLineDash([10, 7])
    ctx.beginPath()
    ctx.arc(p.x, p.y, 34, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = '900 14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#fff3c2'
    ctx.fillText(this.tutorialGuide?.step === 6 ? 'TRY THIS CAP' : 'TARGET', p.x, p.y - 42)
    ctx.restore()
  }

  private openOnline(): void {
    const typed = this.ui?.root.querySelector<HTMLInputElement>('[data-input="online-code"]')?.value ?? ''
    const sharedRoom = (typed || new URL(location.href).searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    const pitches = SURFACE_IDS.map(id => `<button class="opt ${id === this.surface ? 'is-on' : ''}" data-action="surface:${id}"><b>${esc(SURFACES[id].name)}</b><small>${esc(SURFACES[id].blurb)}</small></button>`).join('')
    this.ui.html('[data-online]', `<div class="online-card">
      <span class="kicker">Two devices · one pitch · no accounts</span><h2>Invite a Mate</h2>
      <p class="online-lede">A real head-to-head on two phones or laptops. The room server owns the ball, so both players see the same bounce and the same call.</p>
      <ol class="online-steps">
        <li><span class="online-step-n" aria-hidden="true">1</span><div><strong>Create a room</strong><p>One player starts the room here, then sends the link.</p></div></li>
        <li><span class="online-step-n" aria-hidden="true">2</span><div><strong>Send the link</strong><p>Copy the invite link, or read out the 4–8 character room code.</p></div></li>
        <li><span class="online-step-n" aria-hidden="true">3</span><div><strong>Flick together</strong><p>Each player controls one crew on their own device. The server settles every bounce.</p></div></li>
      </ol>
      <div class="online-preset" data-online-preset>
        <strong>Rules: ${esc(INVITE_PROFILE.name)}</strong>
        <span>Two 3-minute halves · last-touch end lines · hidden penalties · keeper stays on the line · straight-shot timeout. The host's room carries the rules; both players play the same match.</span>
      </div>
      <div class="opt-group online-pitch"><label>Pitch (the host's choice travels with the room)</label><div class="opts">${pitches}</div></div>
      <p class="online-config" data-online-config data-state="checking" role="status">Checking whether online rooms are set up for this build…</p>
      <button class="btn" data-action="online:create" disabled>Create room</button>
      <label class="online-code"><span>Room code</span><input data-input="online-code" value="${esc(sharedRoom)}" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="e.g. 7K4M2B"></label>
      <button class="btn ghost" data-action="online:join" disabled>Join room</button>
      <p class="online-status" data-online-status role="status" aria-live="polite"></p>
      <p class="online-alt">No second device? Quick Match, the AI and the Street Tournament are pass-and-play on this one.</p>
      <button class="chip" data-action="online:back">Back to menu</button>
    </div>`)
    this.ui.show('online')
    void this.checkOnline(sharedRoom)
  }

  private async checkOnline(sharedRoom: string): Promise<void> {
    const config = await probeOnlineConfig()
    if (this.mode !== 'online' || this.ui.root.dataset.current !== 'online') return
    const note = this.ui.root.querySelector<HTMLElement>('[data-online-config]')
    const create = this.ui.root.querySelector<HTMLButtonElement>('[data-action="online:create"]')
    const join = this.ui.root.querySelector<HTMLButtonElement>('[data-action="online:join"]')
    if (!config.ok) {
      if (note) {
        note.dataset.state = 'off'
        note.textContent = 'Online rooms are not configured in this build — there is no public room server for an invite link to reach. Pass-and-play, Quick Match, the AI and the Street Tournament all still work on this device.'
      }
      this.onOnlineStatus('unavailable', 'Invite links need a public room server; this build has none configured.')
      return
    }
    if (note) { note.dataset.state = 'ready'; note.textContent = 'Online rooms are ready in this build. Create a room or join one with a code.' }
    if (create) create.disabled = false
    if (join) join.disabled = false
    this.onOnlineStatus('idle', '')
    if (sharedRoom) void this.connectOnline(sharedRoom)
  }

  private async connectOnline(room: string): Promise<void> {
    this.onlineState = null
    this.onlineTeam = null
    this.lastOnlineGoalSeq = 0
    this.pendingOnlineActions.clear()
    await this.onlineClient?.connect(room, { design: this.settings.teams[0], surface: this.surface })
  }

  /** Incoming crews are sanitised field by field on this end too, then clash-resolved locally. */
  private onlineDesigns(state: NetworkState): [TeamDesign, TeamDesign] {
    return resolveKits(sanitizeTeam(state.teams[0], 0), sanitizeTeam(state.teams[1], 1))
  }

  private onOnlineStatus(state: LinkState, detail?: string): void {
    const status = this.ui?.root.querySelector<HTMLElement>('[data-online-status]')
    if (status) status.textContent = detail ?? ({ discovering: 'Finding the CAPBALL game server…', connecting: 'Joining the room…', open: 'Connected — warming up the pitch…', retrying: 'Reconnecting to the room…', unavailable: ONLINE_NOT_CONFIGURED, closed: 'Room connection closed.', idle: '' }[state])
    if (state === 'retrying' || state === 'unavailable' || state === 'closed') this.onlineSmoother.reset()
    if (this.ui?.root.dataset.current !== 'hud' || this.mode !== 'online') return
    if (state === 'discovering' || state === 'connecting') this.ui.showOnlineWait(this.onlineClient?.room || null, 'Joining the room…')
    else if (state === 'retrying') this.ui.showOnlineWait(this.onlineClient?.room || this.onlineState?.room || null, 'Connection dropped — reconnecting. The room is held for you.')
    else if (state === 'unavailable' || state === 'closed') this.ui.showOnlineWait(this.onlineClient?.room || null, 'Room connection closed. Leave the match to start again.')
    if (state === 'unavailable' || state === 'closed') this.ui.caption(detail ?? 'Room connection lost.', 5000)
  }

  private onOnlineMessage(message: ServerMessage): void {
    if (message.type === 'welcome') {
      const profile = getOnlineProfile(message.state.profile.id, message.state.profile.version)
      this.mode = 'online'
      if (!profile) {
        this.ui.caption('This room uses an online rules profile this build does not know. Refresh CAPBALL to update.', 9000)
        return
      }
      this.onlineTeam = message.role === 'p1' ? 0 : 1
      const designs = this.onlineDesigns(message.state)
      this.startMatch(profile.ruleset, message.state.surface, { online: true, teams: designs })
      this.ui.setOnlinePauseMode(true)
      this.ui.caption(`Room ${message.room} · ${profile.name} on ${SURFACES[message.state.surface].name} · you're ${designs[this.onlineTeam].name}. Share the invite link.`, 7000)
      this.applyOnlineState(message.state)
      return
    }
    if (message.type === 'state') { this.applyOnlineState(message.state); return }
    if (message.type === 'flick') { this.applyOnlineFlick(message); return }
    if (message.type === 'penalty-shot') { this.onOnlinePenaltyShot(message); return }
    if (message.type === 'event') {
      if (message.seq <= this.lastOnlineGoalSeq) return
      this.lastOnlineGoalSeq = message.seq
      if (message.kind === 'goal' && message.team !== null) this.onGoal(message.team, message.end ?? (message.team === 0 ? 1 : 0), !!message.ownGoal, message.score, message.capId ?? null)
      else if (message.kind === 'win') this.onWin(message.team, message.score, 'target')
      return
    }
    if (message.type === 'error') {
      // A rejected prediction never happened on the server; snap rather than gracefully blending a lie.
      if (message.code === 'wrong_turn' || message.code === 'invalid') this.onlineSmoother.reset()
      this.ui.caption(message.message, 4000)
    }
  }

  private applyOnlineState(state: NetworkState): void {
    if (!this.match || this.onlineTeam === null) return
    const previous = this.onlineState
    this.onlineState = state
    const m = this.match
    const designs = this.onlineDesigns(state)
    if (JSON.stringify(designs) !== JSON.stringify(this.teams)) {
      this.teams = designs
      this.renderer.setDesigns(designs)
      this.ui.setTeams(designs)
    }
    const flow = state.penalty
    if (state.ready && state.phase !== 'waiting' && flow) {
      // Freeze local bodies on the first penalty snapshot only, so a keeper drag or a
      // staged shot is never overwritten by the server's neutral set-piece positions.
      if (!this.hiddenPenalty || this.onlinePenaltyId !== flow.id) {
        this.applyOnlineSnapshot(state, false)
        m.paused = false
        this.ui.setScore(state.score)
        this.ui.setTurn(flow.kicker, this.teams, TURN_LABEL.penalty)
        this.beginOnlinePenalty(flow)
      } else {
        this.syncOnlinePenalty(flow)
      }
      this.refreshMeters()
      this.refreshActionButton()
      this.ui.showOnlineWait(null)
      return
    }
    if (this.onlinePenaltyId !== -1) this.endOnlinePenalty()
    if (state.ready && state.phase !== 'waiting') {
      // Blend only continuous play: a new phase, turn, reason or set-piece is a real
      // event and must snap, or the renderer would smear a goal or a reset.
      const smooth = !!previous && previous.ready && state.ready
        && previous.phase === state.phase && previous.reason === state.reason && previous.turn === state.turn
        && !previous.penalty && !state.penalty
        && (state.phase === 'aim' || state.phase === 'moving' || state.phase === 'goal')
      this.applyOnlineSnapshot(state, smooth)
      m.paused = false
      this.ui.setScore(state.score)
      this.ui.setTurn(state.phase === 'over' ? null : state.team, this.teams, TURN_LABEL[state.reason as TurnReason] ?? 'your flick')
      if (state.phase === 'aim' && (!previous || previous.phase !== state.phase || previous.team !== state.team || previous.turn !== state.turn || previous.reason !== state.reason)) this.onTurn(state.team, state.reason as TurnReason)
      this.refreshMeters()
      this.refreshActionButton()
      this.ui.showOnlineWait(null)
    } else {
      m.paused = true
      this.onlineSmoother.reset()
      this.ui.setTurn(null, this.teams, '')
      this.ui.caption(state.connected.some(Boolean) ? `Room ${state.room} · waiting for your mate…` : 'Room paused · reconnecting both players…', 7000)
      this.ui.showOnlineWait(state.room, state.connected.some(Boolean) ? 'Waiting for your mate to join. Share the invite link or room code.' : 'Room paused while both players reconnect.')
    }
  }

  /**
   * Apply the server's authoritative bodies. When `smooth` is true the visible gap is
   * captured as a render-only residual; the physics world already holds the real state.
   * A teleport (goal reset, respawn) exceeds the snap threshold and is not smeared.
   */
  private applyOnlineSnapshot(state: NetworkState, smooth: boolean): void {
    const m = this.match
    if (!m) return
    const before: Pose[] = []
    if (smooth) {
      for (let id = 0; id < 11; id++) {
        const body = id < 10 ? m.world.caps[id] : m.world.ball
        before.push(this.onlineSmoother.apply(id, { x: body.position.x, y: body.position.y, angle: body.angle }))
      }
    } else {
      this.onlineSmoother.reset()
    }
    m.applyAuthoritativeState({
      bodies: { caps: state.bodies.slice(0, 10), ball: state.bodies[10] },
      phase: state.phase as Match['phase'], team: state.team, reason: state.reason as TurnReason,
      turn: state.turn, flicks: state.flicks, score: [...state.score], possession: state.possession,
      armed: state.armed, activeCap: state.activeCap,
    })
    if (!smooth) return
    let largest = 0
    for (let id = 0; id < 11; id++) {
      const next = state.bodies[id]
      const was = before[id]
      if (!next || !was) continue
      const raw = Math.hypot(was.x - next.x, was.y - next.y)
      if (raw > largest) largest = raw
      this.onlineSmoother.correct(id, was, { x: next.x, y: next.y, angle: next.angle })
    }
    this.onlineClient?.diag.correction(largest)
  }

  private beginOnlinePenalty(flow: NetworkPenalty): void {
    const keeperTeam = (1 - flow.kicker) as TeamIndex
    const p = new HiddenPenalty(flow.kicker, keeperTeam, flow.takerId, flow.keeperId, flow.end, FOOTBALL.hiddenPenaltyPhaseMs)
    if (this.onlineTeam === flow.kicker) p.stage = 'cover-shooter'
    this.hiddenPenalty = p
    this.onlinePenaltyId = flow.id
    this.onlinePenaltyRole = this.onlineTeam === flow.kicker ? 'shot' : 'keeper'
    this.onlinePenaltySeal = null
    this.onlinePenaltyCommitted = this.onlineTeam !== null && flow.committed[this.onlineTeam]
    this.onlinePenaltyRevealSent = false
    this.onlinePenaltyStage = flow.stage
    this.penaltyTimerSecond = -1
    this.keeperInput.cancel()
    if (this.onlinePenaltyCommitted) {
      p.stage = 'done'
      this.ui.caption('Your choice is already locked in. Waiting for the reveal…', 4500)
    } else {
      this.showPenaltyCover()
    }
    this.refreshActionButton()
    this.syncOnlinePenalty(flow)
  }

  private syncOnlinePenalty(flow: NetworkPenalty): void {
    if (this.onlinePenaltyId !== flow.id) return
    this.onlinePenaltyStage = flow.stage
    if (flow.stage === 'reveal' && !this.onlinePenaltyRevealSent) {
      this.onlinePenaltyRevealSent = true
      if (this.onlinePenaltySeal) void this.sendOnlinePenaltyReveal()
      else this.ui.caption('Both choices are locked. The server is settling the penalty…', 4000)
    }
  }

  private async sendOnlinePenaltyCommit(): Promise<void> {
    const p = this.hiddenPenalty
    const flow = this.onlineState?.penalty
    const team = this.onlineTeam
    if (!p || !flow || team === null || this.onlinePenaltyId !== flow.id || this.onlinePenaltySeal) return
    let choice: PenaltyChoice | null = null
    if (this.onlinePenaltyRole === 'keeper' && p.keeperPosition) {
      choice = { kind: 'keeper', position: { ...p.keeperPosition } }
    } else if (this.onlinePenaltyRole === 'shot' && p.committedShot) {
      choice = { kind: 'shot', direction: { ...p.committedShot.direction }, power: p.committedShot.power, forfeited: p.forfeited }
    }
    if (!choice) return
    const nonce = randomNonce(16)
    const commit = await sha256Hex(penaltyCommitText(flow.id, team, choice, nonce))
    if (this.hiddenPenalty !== p || this.onlineState?.penalty?.id !== flow.id || this.onlinePenaltyCommitted) return
    if (this.onlineClient?.sendPenaltyCommit(flow.id, commit) === null) {
      this.ui.caption('Choice held while reconnecting — it will send when the room is back.', 4500)
      return
    }
    this.onlinePenaltySeal = { choice, nonce, commit }
    this.onlinePenaltyCommitted = true
    this.refreshActionButton()
  }

  private async sendOnlinePenaltyReveal(): Promise<void> {
    const seal = this.onlinePenaltySeal
    const flow = this.onlineState?.penalty
    if (!seal || !flow || this.onlinePenaltyId !== flow.id) return
    if (this.onlineClient?.sendPenaltyReveal(flow.id, seal.choice, seal.nonce) === null) {
      this.onlinePenaltyRevealSent = false
      this.ui.caption('Reveal held while reconnecting — it will send when the room is back.', 4500)
    }
  }

  private onOnlinePenaltyShot(message: PenaltyShotMessage): void {
    if (message.penaltyId !== this.onlinePenaltyId) return
    const m = this.match
    const keeper = message.keeper
    const keeperSide = keeper.y < PITCH.height / 2 - 8 ? 'upper side' : keeper.y > PITCH.height / 2 + 8 ? 'lower side' : 'centre'
    const dir = message.shot.direction
    const shotSide = dir.y < -0.2 ? 'upper side' : dir.y > 0.2 ? 'lower side' : 'straight'
    if (m) m.world.place(m.world.caps[message.keeperId], keeper, 0)
    this.keeperInput.cancel()
    this.endOnlinePenalty()
    if (m) {
      m.paused = false
      m.tryFlick(message.takerId, dir, message.shot.power, 0)
    }
    this.ui.caption(message.shot.forfeited
      ? `Keeper committed ${keeperSide}. Shot conceded — the server takes it from here.`
      : `Keeper: ${keeperSide}. Shot: ${shotSide}. The server settles the bounce.`, 4000)
  }

  private endOnlinePenalty(): void {
    this.hiddenPenalty?.finish()
    this.hiddenPenalty = null
    this.onlinePenaltyId = -1
    this.onlinePenaltyRole = null
    this.onlinePenaltySeal = null
    this.onlinePenaltyCommitted = false
    this.onlinePenaltyRevealSent = false
    this.onlinePenaltyStage = null
    this.keeperInput.cancel()
    this.penaltyTimerSecond = -1
    this.ui.setPenaltyTimer(null)
    const open = this.ui.root.querySelector<HTMLElement>('.modal.is-active')?.dataset.modal
    if (open === 'penalty-cover' || open === 'penalty-reveal') this.ui.modal(null)
  }

  private applyOnlineFlick(message: FlickMessage): void {
    if (this.pendingOnlineActions.delete(message.actionId)) return
    const m = this.match
    if (!m || message.team === this.onlineTeam || m.team !== message.team || m.phase !== 'aim') return
    if (message.arm && !m.toggleArm()) return
    m.tryFlick(message.capId, message.dir, message.power, message.spin)
  }

  private commitFlick(id: number, dir: Vec, power: number, spin: number): void {
    const m = this.match
    if (!m) return
    if ((this.mode !== 'online' || this.onlinePenaltyId !== -1) && this.hiddenPenalty?.stage === 'shooter' && id === this.hiddenPenalty.takerId) {
      if (this.hiddenPenalty.stageShot({ direction: dir, power })) {
        this.ui.restartBanner('Shot staged · lock it to reveal', this.teams[this.hiddenPenalty.kicker].primary)
        this.refreshActionButton()
      }
      return
    }
    const arm = m.armed === m.team
    if (!m.tryFlick(id, dir, power, spin)) return
    this.restartZone = null
    if (this.mode !== 'online') return
    const actionId = this.onlineClient?.sendFlick({ capId: id, dir, power, spin, arm }) ?? null
    if (actionId === null) { m.paused = true; this.ui.caption('Flick held while reconnecting — your mate will catch up.', 4000); return }
    this.pendingOnlineActions.add(actionId)
    if (this.pendingOnlineActions.size > 20) this.pendingOnlineActions.clear()
  }

  resize(): void {
    const top = this.ui.root.querySelector<HTMLElement>('.scorebar')?.offsetHeight ?? 60
    this.renderer.resize(window.innerWidth, window.innerHeight, Math.max(56, top + 6), 52, this.tune?.dock())
  }

  // ---------------------------------------------------------------- screens
  private openSetup(): void {
    const m = this.mode
    const tournamentAi = this.settings.tournamentAi
    this.ui.html('[data-setup]', setupHtml({
      title: m === 'quick' ? 'Quick match' : m === 'ai' ? 'CAPBALL vs the machine' : m === 'shootout' ? 'Penalty shootout' : 'Street tournament',
      sub: m === 'quick' ? 'Pass the phone, take turns, talk trash.'
        : m === 'ai' ? 'One human. One mouthy computer. Pick its street cred.'
          : m === 'shootout' ? 'Five kicks each, then sudden death. Every cap takes one — even the keeper.'
            : tournamentAi ? 'Your crew against three street rivals. Win three ties, lift the cup.'
              : 'Four crews, two semis, one final. Draws go to penalties.',
      presetId: this.settings.ruleset, overrides: this.settings.flags, surface: this.surface, showRules: m !== 'shootout',
      showAi: m === 'ai' || (m === 'tournament' && tournamentAi),
      aiLabel: m === 'tournament' ? 'Pick the rival difficulty' : 'Pick your opponent',
      aiLevel: this.settings.aiLevel,
      showTournament: m === 'tournament',
      tournamentAi,
      penaltyTimeout: this.settings.penaltyTimeout, allowHiddenPenalties: m === 'quick' || m === 'tournament',
      goLabel: m === 'tournament' ? 'Draw the bracket' : m === 'ai' ? 'Take on the AI' : 'Kick off',
    }))
    this.ui.show('setup')
  }

  private openEditor(from: 'setup' | 'start'): void {
    this.editorReturn = from
    const root = this.ui.$('[data-editor]')
    root.innerHTML = editorHtml(this.settings.teams)
    drawPreviews(root, this.settings.teams)
    this.ui.show('editor')
  }

  private editTeam(arg: string, el: HTMLElement): void {
    const [iStr, field, slotStr] = arg.split(':')
    const i = Number(iStr) as 0 | 1
    const t = this.settings.teams[i]
    const v = (el as HTMLInputElement).value
    if (field === 'name') t.name = v
    else if (field === 'primary' || field === 'secondary') t[field] = v
    else if (field === 'num') t.numbers[Number(slotStr)] = v.replace(/[^0-9A-Za-z]/g, '').slice(0, 2)
    else if (field === 'cname') t.capNames[Number(slotStr)] = v
    drawPreviews(this.ui.$('[data-editor]'), this.settings.teams)
  }

  private closeEditor(): void {
    this.settings.teams = [sanitizeTeam(this.settings.teams[0], 0), sanitizeTeam(this.settings.teams[1], 1)]
    saveSettings(this.settings)
    this.teams = resolveKits(this.settings.teams[0], this.settings.teams[1])
    this.renderer.setDesigns(this.teams)
    if (this.editorReturn === 'setup') this.openSetup()
    else this.toMenu()
  }

  private bracketMarkup(tour: Tournament, highlight: Tie | null): string {
    const crew = (i: number | null) => (i === null ? null : tour.crews[i])
    const row = (t: Tie, side: 'home' | 'away') => {
      const idx = t[side]
      const c = crew(idx)
      const g = t.result ? t.result.goals[side === 'home' ? 0 : 1] : ''
      const so = t.result?.shootout ? ` <small>(${t.result.shootout[side === 'home' ? 0 : 1]})</small>` : ''
      const win = t.result && t.result.winner === idx
      return `<div class="row ${win ? 'win' : ''}"><span>${c ? `<span class="dot" style="background:${c.primary}"></span>${esc(c.name)}` : '<em>TBC</em>'}</span><span>${g}${so}</span></div>`
    }
    const tie = (t: Tie, cls = '') => `<div class="tie ${cls} ${highlight === t ? 'next' : ''}"><small>${t.label}${t.result?.simulated ? ' · AI result' : ''}</small>${row(t, 'home')}${row(t, 'away')}</div>`
    return `<div class="bracket">${tie(tour.ties[0])}${tie(tour.ties[1])}${tie(tour.ties[2], 'final')}</div>`
  }

  private renderBracket(): void {
    const tour = this.tournament!
    const next = tour.next
    const champ = tour.champion
    const aiTag = this.aiTournament ? ` · ${AI.levels[this.settings.aiLevel].name} AI` : ''
    const opponent = this.aiTournament && next ? tour.crews[next.home === 0 ? next.away! : next.home!] : null
    const sub = champ !== null
      ? `${esc(tour.crews[champ].name)} rule the streets.`
      : next ? `Up next: ${next.label}${opponent ? ` — you vs ${esc(opponent.name)}` : ''}${aiTag}`
        : ''
    this.ui.html('[data-bracket]', `
      <div class="tape tape-b"></div>
      <h2>${champ !== null ? 'Champions!' : 'The bracket'}</h2>
      <p class="sub" data-bracket-ai="${this.aiTournament ? this.settings.aiLevel : ''}">${sub}</p>
      ${this.bracketMarkup(tour, next)}
      <div class="setup-actions">
        ${champ !== null
          ? `<button class="btn" data-action="cup">View the cup</button><button class="btn ghost small" data-action="mode:tournament">New tournament</button>`
          : next ? `<button class="btn" data-action="playtie">Play ${next.label}</button>` : ''}
        <button class="chip" data-action="back">Menu</button>
      </div>`)
    this.ui.show('bracket')
  }

  private renderCup(): void {
    const tour = this.tournament
    if (!tour || tour.champion === null) { this.renderBracket(); return }
    const champ = tour.crews[tour.champion]
    const final = tour.ties[2].result!
    const home = tour.crews[final.home!]
    const away = tour.crews[final.away!]
    const pens = final.shootout ? ` <small>(${final.shootout[0]}–${final.shootout[1]} pens)</small>` : ''
    const eliminated = this.aiTournament && tour.champion !== 0
    const sub = eliminated
      ? 'The street machine takes the cup. Your run ends here — but the scoreboard never lies.'
      : this.aiTournament ? 'Your crew rule the streets. Three ties, one cup.' : 'Two crews, one cup, no mercy.'
    const simulated = tour.ties.some(t => t.result?.simulated)
    this.ui.html('[data-cup]', `
      <div class="tape tape-a"></div>
      <p class="cup-kicker">Street tournament · ${this.aiTournament ? `${esc(AI.levels[this.settings.aiLevel].name)} AI` : 'Local 2P'}</p>
      <div class="cup-trophy" aria-hidden="true">${CUP_TROPHY_SVG}</div>
      <h2 class="cup-champ" style="--champ:${champ.primary}">${esc(champ.name)}</h2>
      <p class="cup-sub">${sub}</p>
      <div class="cup-final" aria-label="Cup final score">
        <div class="cup-final-side" style="--team:${home.primary}"><span class="dot"></span><span>${esc(home.name)}</span><strong>${final.goals[0]}${pens}</strong></div>
        <span class="cup-final-divider" aria-hidden="true">–</span>
        <div class="cup-final-side" style="--team:${away.primary}"><span class="dot"></span><span>${esc(away.name)}</span><strong>${final.goals[1]}</strong></div>
      </div>
      <p class="cup-final-label">Cup final${final.simulated ? ' · settled by the street AI' : ''}</p>
      <div class="cup-crew" aria-label="${esc(champ.name)} starting caps">
        ${[0, 1, 2, 3, 4].map(slot => `<canvas data-preview="0:${slot}" width="108" height="108"></canvas>`).join('')}
      </div>
      <h3 class="cup-road">The road to the cup</h3>
      ${this.bracketMarkup(tour, null)}
      ${simulated ? '<p class="cup-note">Rival-vs-rival ties were settled by the deterministic street AI.</p>' : ''}
      <div class="setup-actions cup-actions">
        <button class="btn" data-action="mode:tournament">New tournament</button>
        <button class="btn ghost" data-action="back">Menu</button>
      </div>`)
    this.ui.show('cup')
    drawPreviews(this.ui.$('[data-cup]'), [champ, champ])
  }

  // ---------------------------------------------------------------- match lifecycle
  startMatch(rules: Ruleset, surface: SurfaceId, opts: { live?: boolean; shootout?: boolean; teams?: [TeamDesign, TeamDesign]; vsAi?: boolean; online?: boolean } = {}): void {
    const live = opts.live ?? true
    this.endMatch()
    this.onlineSmoother.reset()
    this.onlineDiagMs = 0
    const m = new Match({ ruleset: rules, surface, shootout: opts.shootout ? { first: 0 } : undefined })
    this.match = m
    this.ruleset = rules
    this.live = live
    this.aiBrain = opts.vsAi ? new AiBrain(rules, surface, this.settings.aiLevel) : null
    this.teams = opts.teams ?? resolveKits(this.settings.teams[0], this.settings.teams[1])
    this.tune.attachMatch(m)
    this.recorder = new ReplayRecorder(m.world)
    m.onFixedStep = () => this.recorder?.record()
    this.renderer.setSurface(surface)
    this.renderer.setDesigns(this.teams)
    this.ui.setTeams(this.teams)
    this.ui.setOnlinePauseMode(!!opts.online)
    if (!opts.online) this.ui.setOnlineDiagnostics(null)
    this.ui.setTutorialPauseMode(this.mode === 'tutorial')
    this.ui.setScore([0, 0])
    this.ui.html('[data-rules-body]', rulesHtml(rules, surface, !!opts.shootout))
    this.particles.clear()
    this.shake.clear()
    this.matchUnsubs.push(
      m.events.on('contact', c => this.onContact(c)),
      m.events.on('flick', f => {
        this.matchStatistics.recordFlick(f.team, f.powerShot)
        if (this.mode === 'tutorial' && this.tutorialGuide) {
          if (this.tutorialGuide.onFlick(f.team, f.powerShot, m.world.capInfo(f.capId).type.id, f.power)) this.tutorialProgressChanged()
          else this.syncTutorialCoach()
        }
        this.audio.flick(f.power)
        if (Math.abs(f.spin) > 0.6 && f.power > 0.45 && Math.random() < 0.5) this.say('curler', {}, 1)
        if (f.powerShot) { this.ui.banner('POWER SHOT!', '#ff7a1f', 900); this.say('powerShot', {}, 2); this.shake.add(4) }
        this.refreshMeters()
        this.refreshActionButton()
      }),
      m.events.on('turn', t => { if (!opts.online) this.onTurn(t.team, t.reason) }),
      m.events.on('goal', g => { if (!opts.online) this.onGoal(g.scorer, g.end, g.ownGoal, g.score.goals, g.capId) }),
      m.events.on('win', w => { if (!opts.online) this.onWin(w.team, w.score.goals, w.reason) }),
      m.events.on('phase', p => { if (p.phase !== 'aim') this.input.cancel(); this.refreshActionButton(); if (this.mode === 'tutorial') this.syncTutorialCoach() }),
      m.events.on('whistle', w => this.onWhistle(w)),
      m.events.on('restart', r => this.onRestart(r)),
      m.events.on('play', e => {
        this.matchStatistics.recordPlay(e)
        if (this.mode === 'tutorial' && this.tutorialGuide && this.tutorialGuide.onPlay(e)) this.tutorialProgressChanged()
        else if (this.mode === 'tutorial') this.syncTutorialCoach()
        this.onPlayEvent(e)
      }),
      m.events.on('settled', () => {
        if (this.mode !== 'tutorial' || !this.tutorialGuide) return
        if (this.tutorialGuide.onSettled()) this.tutorialProgressChanged()
        else this.syncTutorialCoach()
      }),
      m.events.on('half', h => { this.audio.whistle(true); this.ui.banner(h.half === 2 ? 'HALF TIME' : `HALF ${h.half}`, '#151515', 1800, true); this.say('halftime', {}, 3) }),
      m.events.on('kick', k => this.onKick(k.team, k.scored, k.saved)),
      m.events.on('step', s => this.onStep(s.dtMs)),
    )
    this.ui.setClock(rules.halves && !opts.shootout ? fmtClock(rules.halves.seconds) : null)
    this.clockText = ''
    this.refreshMeters()
    if (live) {
      this.ui.show('hud')
      this.ui.modal(null)
      this.resize()
      if (!opts.online) {
        this.onTurn(m.team, m.reason)
        this.audio.whistle()
        this.say('kickoff', { team: this.teams[m.team].name }, 3)
      }
    }
  }

  endMatch(): void {
    this.cancelAi()
    window.clearTimeout(this.penaltyRevealTimer)
    this.penaltyRevealTimer = 0
    this.hiddenPenalty?.finish()
    this.hiddenPenalty = null
    this.onlinePenaltyId = -1
    this.onlinePenaltyRole = null
    this.onlinePenaltySeal = null
    this.onlinePenaltyCommitted = false
    this.onlinePenaltyRevealSent = false
    this.onlinePenaltyStage = null
    this.keeperInput.cancel()
    this.penaltyTimerSecond = -1
    this.ui.setPenaltyTimer(null)
    this.restartZone = null
    for (const u of this.matchUnsubs) u()
    this.matchUnsubs = []
    this.input.cancel()
    this.aim = null
    this.replay = null
    this.matchStatistics.reset()
    this.lastGoalReplay = null
    this.matchSummary = null
    this.summaryActions = ''
    this.goalHoldMs = -1
    this.ui.$('[data-replay]').hidden = true
    if (this.match) this.match.onFixedStep = null
    this.tune.detachMatch()
    this.match?.destroy()
    this.match = null
    this.recorder = null
    this.voice.stop()
    this.ui.clearOverlays()
  }

  private capName(id: number | null): string {
    if (id === null || !this.match) return 'somebody'
    const info = this.match.world.capInfo(id)
    return this.teams[info.team].capNames[info.slot] || CAP_TYPES[info.type.id].label
  }

  private onGoal(scorer: TeamIndex, end: 0 | 1, ownGoal: boolean, goals: [number, number], capId: number | null): void {
    const m = this.match!
    this.lastGoalReplay = null
    this.ui.setScore(goals)
    this.audio.horn()
    this.crowd.swell(1, 4)
    const d = this.teams[scorer]
    this.ui.banner(ownGoal ? 'OWN GOAL!' : 'GOAL!', d.primary, 1500, true)
    this.ui.setTurn(null, this.teams, '')
    this.shake.add(FX.shakeOnGoal)
    const gx = end === 0 ? 0 : PITCH.width
    this.particles.confetti(gx, PITCH.height / 2, end === 0 ? 1 : -1, 140, [d.primary, d.secondary, '#ffffff', '#ffd23f'])
    const vars = { team: d.name, other: this.teams[1 - scorer].name, cap: this.capName(capId), score: `${goals[0]}–${goals[1]}` }
    this.say(ownGoal ? 'ownGoal' : 'goal', vars, 3)
    this.refreshMeters()
    if (this.mode === 'online') return // the server keeps the goal phase and score authoritative
    // Open play: hold the match, let the celebration breathe, then roll the slow-mo replay.
    if (!m.shootout) { m.holdAfterGoal = true; this.goalHoldMs = 0; this.goalMark = this.recorder?.mark() ?? 0 }
  }

  private startReplay(): void {
    const m = this.match
    if (!m || !this.recorder) return
    const clip = this.recorder.clipAround(this.goalMark, FX.replaySeconds, FX.replayTail)
    this.lastGoalReplay = clip.duration >= 0.6 ? clip : null
    if (clip.duration < 0.6 || !this.settings.replays) { m.finishGoal(); return }
    m.enterReplay()
    this.replay = { clip, t: 0, returnToSummary: false }
    this.ui.$('[data-replay]').hidden = false
    this.crowd.swell(0.5, 3)
  }

  /** Public skip (UI button, tap, tests). */
  skipReplay(): void { this.endReplay() }

  private endReplay(): void {
    if (!this.replay) return
    const returnToSummary = this.replay.returnToSummary ?? false
    this.replay = null
    this.ui.$('[data-replay]').hidden = true
    if (returnToSummary) this.showMatchSummary()
    else this.match?.finishGoal()
  }

  private playLastGoalReplay(): void {
    if (!this.match || this.match.phase !== 'over' || !this.matchSummary || !this.lastGoalReplay) return
    this.ui.modal(null)
    this.replay = { clip: this.lastGoalReplay, t: 0, returnToSummary: true }
    this.ui.$('[data-replay]').hidden = false
    this.crowd.swell(0.35, 1.5)
  }

  private showMatchSummary(): void {
    if (!this.matchSummary) return
    this.ui.showMatchSummary({ ...this.matchSummary, replayAvailable: this.lastGoalReplay !== null }, this.summaryActions)
  }

  private onTurn(team: TeamIndex, reason: TurnReason): void {
    const m = this.match
    const callOut = this.lastOut
    if (this.mode === 'tutorial' && this.tutorialGuide) {
      if (this.tutorialGuide.complete) { this.finishTutorial(); return }
      if (team !== 0 && m?.phase === 'aim') {
        m.turns.startTurn(0, 'normal')
        this.onTurn(0, 'normal')
        return
      }
      if (team === 0) this.stageTutorialScenario()
      this.syncTutorialCoach()
    }
    if (reason === 'normal' || reason === 'bonus' || reason === 'kickoff' || reason === 'halftime') this.restartZone = null
    this.ui.setTurn(team, this.teams, TURN_LABEL[reason])
    const color = this.teams[team].primary
    if (reason === 'bonus') { this.ui.banner('BONUS FLICK!', color, 1100); this.crowd.chant() }
    if (reason === 'corner' || reason === 'goalkick' || reason === 'freekick' || reason === 'penalty' || reason === 'offside' || reason === 'dropball') {
      if (!this.restartZone || this.restartZone.team !== team) this.ui.restartBanner(`${TURN_LABEL[reason]} · ${this.teams[team].name}`, color)
      if (reason === 'corner' || reason === 'goalkick') {
        // Always explain who gave it away — this is a rule call, not just colour commentary.
        const other = this.teams[team === 0 ? 1 : 0].name
        const own = m?.ruleset.outBy === 'lastTouch' ? 'touched it last before it went' : 'flicked it'
        const why = reason === 'corner'
          ? `${other} ${own} out behind their own goal → corner to ${this.teams[team].name}.`
          : `${other} ${own} out over ${this.teams[team].name}'s end line → goal kick.`
        if (this.lastOut) { this.outMark = { ...this.lastOut, t0: performance.now() }; this.lastOut = null } // show the spot with the call
        this.say(reason, { team: this.teams[team].name, other }, 2) // voice + colour
        this.ui.caption(why, 3200) // the caption always states the actual rule call
      }
      if (reason === 'penalty' || reason === 'dropball') this.say(reason, { team: this.teams[team].name }, 2)
    }
    if (reason === 'keeper' && m?.shootout) {
      const so = m.shootout
      const kicker = so.kicker
      this.ui.banner(`${so.suddenDeath ? 'SUDDEN DEATH · ' : ''}KICK ${Math.floor((so.taken(0) + so.taken(1)) / 2) + 1}`, this.teams[kicker].primary, 1100)
      this.ui.caption(this.aiBrain && team === 1
        ? `${this.teams[team].name} keeper is picking a spot. ${this.capName(m.takerId)} steps up.`
        : `${this.teams[team].name}: drag your keeper along the line, then lock it. ${this.capName(m.takerId)} steps up.`, 3200)
    }
    this.refreshMeters()
    this.refreshActionButton()
    if (reason === 'penalty' && m?.ruleset.hiddenPenalties && (this.mode === 'quick' || this.mode === 'tournament')) this.beginHiddenPenalty(team)
    if (this.aiBrain && team === 1 && this.live) this.scheduleAi(m)
    else this.cancelAi()
    const shootout = reason === 'keeper' && !!m?.shootout
    this.showFirstRuleHint(shootout ? 'penalty' : reason, shootout ? m!.shootout!.kicker : team, callOut, shootout)
    this.lastRuleWhistle = null
  }

  private beginHiddenPenalty(kicker: TeamIndex): void {
    const m = this.match
    if (!m || m.shootout || m.takerId < 0 || m.keeperId < 0) return
    const keeperTeam = (1 - kicker) as TeamIndex
    this.hiddenPenalty = new HiddenPenalty(kicker, keeperTeam, m.takerId, m.keeperId, keeperTeam as 0 | 1, FOOTBALL.hiddenPenaltyPhaseMs)
    this.penaltyTimerSecond = -1
    this.penaltyAiMs = 0
    // The AI keeper never gets a "pass the phone" card: pick a legal spot, hide it, and
    // hand the phone straight to the human shooter.
    if (this.aiBrain && keeperTeam === 1) {
      const p = this.hiddenPenalty
      p.dismissCover()
      const radius = m.world.capInfo(p.keeperId).type.radius
      const line = p.end === 1 ? PITCH.width : 0
      p.lockKeeper(legalKeeperPosition({ x: line, y: this.aiBrain.keeperGuess() }, p.end, radius, m.ruleset.keeperMayLeaveLine))
      this.placeKeeperNeutral(p)
    }
    this.showPenaltyCover()
    this.refreshActionButton()
  }

  private showPenaltyCover(): void {
    const p = this.hiddenPenalty
    if (!p) return
    const online = this.mode === 'online'
    if (p.stage === 'cover-keeper') {
      this.ui.showPenaltyCover(
        `${this.teams[p.keeperTeam].name}: choose the keeper spot`,
        online
          ? `Set your keeper, then tap Lock Keeper. Your mate cannot see your locked spot until the server reveals both choices.`
          : `Pass the phone to the keeper's player. Set the keeper, then tap Lock Keeper. The shooter cannot see the locked spot.`,
        'Keeper is ready', this.teams[p.keeperTeam].primary,
      )
    } else if (p.stage === 'cover-shooter') {
      this.ui.showPenaltyCover(
        `${this.teams[p.kicker].name}: take the shot`,
        online
          ? `The keeper choice is locked and hidden. Stage one flick, then tap Lock Shot. The server reveals both choices together.`
          : `Keeper choice is locked and hidden. Pass the phone to the shooter, then stage one flick and tap Lock Shot.`,
        'Shooter is ready', this.teams[p.kicker].primary,
      )
    }
  }

  private dismissPenaltyCover(): void {
    const p = this.hiddenPenalty
    if (!p || !p.dismissCover()) return
    this.ui.modal(null)
    if (this.match) this.match.paused = false
    this.penaltyTimerSecond = -1
    if (p.stage === 'keeper') {
      this.ui.setTurn(p.keeperTeam, this.teams, 'choose the keeper spot')
      this.ui.restartBanner('Keeper chooses · hidden from shooter', this.teams[p.keeperTeam].primary)
    } else {
      const m = this.match
      if (m) this.placeKeeperNeutral(p)
      this.ui.setTurn(p.kicker, this.teams, 'stage a shot, then lock it')
      this.ui.restartBanner('Shooter chooses · keeper choice stays hidden', this.teams[p.kicker].primary)
    }
    this.refreshActionButton()
  }

  private keeperDragTarget(): { x: number; y: number; radius: number } | null {
    const p = this.hiddenPenalty
    const m = this.match
    if (!p || p.stage !== 'keeper' || !m || m.phase !== 'aim' || m.paused) return null
    const body = m.world.caps[p.keeperId]
    return body ? { x: body.position.x, y: body.position.y, radius: m.world.capInfo(p.keeperId).type.radius } : null
  }

  private movePenaltyKeeper(position: Vec): void {
    const p = this.hiddenPenalty
    const m = this.match
    if (!p || p.stage !== 'keeper' || !m) return
    const radius = m.world.capInfo(p.keeperId).type.radius
    const legal = legalKeeperPosition(position, p.end, radius, m.ruleset.keeperMayLeaveLine)
    m.world.place(m.world.caps[p.keeperId], legal, 0)
  }

  private placeKeeperNeutral(p: HiddenPenalty): void {
    const m = this.match
    if (!m) return
    const radius = m.world.capInfo(p.keeperId).type.radius
    const line = p.end === 0 ? 0 : PITCH.width
    const neutral = legalKeeperPosition({ x: line, y: PITCH.height / 2 }, p.end, radius, m.ruleset.keeperMayLeaveLine)
    m.world.place(m.world.caps[p.keeperId], neutral, 0)
  }

  private lockPenaltyKeeper(): void {
    const p = this.hiddenPenalty
    const m = this.match
    if (!p || !m || p.stage !== 'keeper') return
    const body = m.world.caps[p.keeperId]
    const radius = m.world.capInfo(p.keeperId).type.radius
    const choice = legalKeeperPosition({ x: body.position.x, y: body.position.y }, p.end, radius, m.ruleset.keeperMayLeaveLine)
    if (!p.lockKeeper(choice)) return
    this.keeperInput.cancel()
    this.penaltyTimerSecond = -1
    if (this.mode === 'online') {
      // The keeper keeps their own spot on their own screen; only the server sees the choice.
      this.ui.modal(null)
      this.ui.caption('Keeper locked · hidden from your mate until the shot is locked.', 4500)
      this.refreshActionButton()
      void this.sendOnlinePenaltyCommit()
      return
    }
    // Hide the committed position from the shooter until their own shot is locked.
    this.placeKeeperNeutral(p)
    if (this.aiBrain && p.kicker === 1) {
      // The AI taker does not need a pass-the-phone card; skip straight to its shot.
      p.dismissCover()
      this.ui.modal(null)
      this.penaltyAiMs = 900
      this.ui.setTurn(p.kicker, this.teams, 'AI taker steps up')
      this.ui.caption(`${this.teams[p.kicker].name} taker is choosing a corner…`, 1200)
      this.refreshActionButton()
      return
    }
    this.showPenaltyCover()
    this.refreshActionButton()
  }

  private lockPenaltyShot(): void {
    const p = this.hiddenPenalty
    if (!p || !p.lockShot()) return
    if (this.mode === 'online') {
      this.ui.modal(null)
      this.ui.caption('Shot locked · waiting for the keeper reveal…', 4500)
      this.refreshActionButton()
      void this.sendOnlinePenaltyCommit()
      return
    }
    this.revealPenalty()
  }

  private forfeitPenalty(): void {
    const p = this.hiddenPenalty
    if (this.mode === 'online' && p && p.stage === 'shooter') {
      if (!p.stageShot({ direction: { x: p.end === 0 ? 1 : -1, y: 0 }, power: FOOTBALL.forfeitPower })) return
      if (!p.lockShot()) return
      p.forfeited = true
      this.ui.modal(null)
      this.ui.caption('Kick conceded · waiting for the keeper reveal…', 4500)
      this.refreshActionButton()
      void this.sendOnlinePenaltyCommit()
      return
    }
    if (this.hiddenPenalty?.forfeit()) this.revealPenalty()
  }

  private penaltyStraightShot(p: HiddenPenalty): { direction: Vec; power: number } {
    return { direction: { x: p.end === 0 ? -1 : 1, y: 0 }, power: FOOTBALL.timeoutStraightPower }
  }

  private advanceHiddenPenalty(dtMs: number): void {
    const p = this.hiddenPenalty
    if (!p) return
    if (this.mode === 'online') {
      // The server owns the deadline and defaults; the client only renders the countdown.
      const flow = this.onlineState?.penalty
      if (!flow || this.onlinePenaltyId !== flow.id) return
      if (p.stage === 'keeper' || p.stage === 'shooter') {
        const seconds = Math.max(0, Math.ceil((flow.deadline - Date.now()) / 1000))
        if (seconds !== this.penaltyTimerSecond) {
          this.penaltyTimerSecond = seconds
          this.ui.setPenaltyTimer(seconds)
        }
      }
      return
    }
    // An AI taker picks its own corner after the human keeper has committed.
    if (this.aiBrain && p.kicker === 1 && p.stage === 'shooter') {
      this.penaltyAiMs = Math.max(0, this.penaltyAiMs - dtMs)
      if (this.penaltyAiMs > 0) return
      const choice = this.aiBrain.penaltyShot(p.end)
      if (p.stageShot(choice) && p.lockShot()) this.revealPenalty()
      return
    }
    if (p.stage === 'keeper' || p.stage === 'shooter') {
      const seconds = Math.max(0, Math.ceil((p.timeoutMs - p.elapsedMs) / 1000))
      if (seconds !== this.penaltyTimerSecond) {
        this.penaltyTimerSecond = seconds
        this.ui.setPenaltyTimer(seconds)
      }
      if (!p.tick(dtMs)) return
      if (p.stage === 'keeper') {
        const target = this.keeperDragTarget()
        p.timeoutKeeper(target ? { x: target.x, y: target.y } : { x: p.end === 0 ? 0 : PITCH.width, y: PITCH.height / 2 })
        this.lockPenaltyKeeperAfterTimeout(p)
      } else {
        if (p.timeoutShooter(this.match?.ruleset.penaltyTimeout ?? 'straight', this.penaltyStraightShot(p))) this.revealPenalty()
      }
    }
  }

  private lockPenaltyKeeperAfterTimeout(p: HiddenPenalty): void {
    this.placeKeeperNeutral(p)
    this.keeperInput.cancel()
    this.penaltyTimerSecond = -1
    if (this.aiBrain && p.kicker === 1) {
      p.dismissCover()
      this.ui.modal(null)
      this.penaltyAiMs = 900
      this.ui.setTurn(p.kicker, this.teams, 'AI taker steps up')
      this.refreshActionButton()
      return
    }
    this.showPenaltyCover()
    this.refreshActionButton()
  }

  private revealPenalty(): void {
    const p = this.hiddenPenalty
    const m = this.match
    if (!p || !m || p.stage !== 'reveal') return
    this.ui.setPenaltyTimer(null)
    this.penaltyTimerSecond = -1
    const keeperPosition = p.keeperPosition ?? legalKeeperPosition({ x: p.end === 0 ? 0 : PITCH.width, y: PITCH.height / 2 }, p.end, m.world.capInfo(p.keeperId).type.radius, m.ruleset.keeperMayLeaveLine)
    m.world.place(m.world.caps[p.keeperId], keeperPosition, 0)
    const choice = p.forfeited ? null : p.committedShot ?? this.penaltyStraightShot(p)
    const keeperSide = keeperPosition.y < PITCH.height / 2 - 8 ? 'upper side' : keeperPosition.y > PITCH.height / 2 + 8 ? 'lower side' : 'centre'
    const shotSide = choice ? choice.direction.y < -0.2 ? 'upper side' : choice.direction.y > 0.2 ? 'lower side' : 'straight' : null
    const text = p.forfeited
      ? `${this.teams[p.kicker].name} forfeited the kick. The keeper committed ${keeperSide}.`
      : `Keeper: ${keeperSide}. Shot: ${shotSide}. Now see if the cap can beat the gloves.`
    this.ui.showPenaltyReveal(text, this.teams[p.kicker].primary)
    this.keeperInput.cancel()
    window.clearTimeout(this.penaltyRevealTimer)
    this.penaltyRevealTimer = window.setTimeout(() => {
      if (this.hiddenPenalty !== p || this.match !== m) return
      this.hiddenPenalty = null
      p.finish()
      this.ui.modal(null)
      m.paused = false
      this.restartZone = null
      this.ui.setTurn(p.kicker, this.teams, 'take the penalty')
      const shot = choice ?? { direction: { x: p.end === 0 ? 1 : -1, y: 0 }, power: FOOTBALL.forfeitPower }
      m.tryFlick(p.takerId, shot.direction, shot.power)
      this.refreshActionButton()
    }, 900)
  }

  private onKick(team: TeamIndex, scored: boolean, saved: boolean): void {
    this.refreshMeters()
    if (scored) return
    this.audio.whistle()
    this.crowd.ooh()
    this.ui.banner(saved ? 'SAVED!' : 'MISSED!', this.teams[saved ? 1 - team : team].primary, 1100)
    this.say(saved ? 'save' : 'miss', { team: this.teams[team].name }, 3)
  }

  private onWhistle(w: Whistle | { kind: 'dropball' }): void {
    this.audio.whistle()
    if (w.kind === 'dropball') { this.ui.banner('DEAD BALL', '#f5d000', 1200); return }
    this.lastRuleWhistle = w
    this.crowd.ooh()
    this.ui.banner(w.kind === 'foul' ? 'FOUL!' : 'OFFSIDE!', '#f5d000', 1200)
    this.say(w.kind === 'foul' ? 'foul' : 'offside', {}, 3)
  }

  private onRestart(r: { kind: Outcome['kind']; team: TeamIndex; at: Vec | null; end: 0 | 1 | null; retake: boolean }): void {
    this.restartZone = r
    const labels: Record<Outcome['kind'], string> = {
      normal: 'Play on', bonus: 'Bonus flick', freekick: 'Free kick', penalty: 'Penalty', corner: 'Corner',
      goalkick: r.retake ? 'Goal-kick retake' : 'Goal kick', dropball: 'Dropped ball',
    }
    this.ui.restartBanner(`${labels[r.kind]} · ${this.teams[r.team].name}`, this.teams[r.team].primary)
  }

  private showFirstRuleHint(reason: TurnReason, team: TeamIndex, out: Vec | null, shootout = false): void {
    if (this.mode === 'tutorial' || !this.live) return
    const key: RuleHintKey | null = shootout ? 'shootout' : reason === 'goalkick' ? 'goalKick'
      : reason === 'corner' ? 'corner'
        : reason === 'penalty' ? 'penalty'
          : reason === 'offside' ? 'offside'
            : reason === 'freekick' ? (this.lastRuleWhistle?.kind === 'offside' ? 'offside' : 'foul') : null
    if (!key || this.settings.ruleHintsSeen[key]) return
    const other = this.teams[team === 0 ? 1 : 0].name
    const awarded = this.teams[team].name
    const lastTouch = this.match?.ruleset.outBy === 'lastTouch' ? 'touched it last' : 'flicked it'
    let why = `${other} gave away this restart.`
    let restriction = 'Follow the marked restart area and keep the play legal.'
    if (shootout) {
      why = 'This match is level, so the teams are taking alternating penalty kicks to decide it.'
      restriction = 'The keeper sets on the line; the kicker gets one flick from the spot.'
    } else if (key === 'goalKick') {
      why = `${other} ${lastTouch} before the ball crossed ${awarded}'s end line.`
      restriction = 'The keeper stands behind the ball. Opponents must stay outside the penalty area until the ball clears it.'
    } else if (key === 'corner') {
      why = `${other} ${lastTouch} before the ball crossed their own end line${out ? ` near the ${out.y < PITCH.height / 2 ? 'upper' : 'lower'} corner` : ''}.`
      restriction = `Defenders retreat at least ${Math.round(this.match?.ruleset.wallDistance ?? 0)} px from the corner ball.`
    } else if (key === 'foul') {
      const culprit = this.lastRuleWhistle?.kind === 'foul' ? this.teams[this.lastRuleWhistle.offender].name : other
      why = `${culprit} flicked a cap into an opponent before touching the ball.`
      restriction = `The other side restarts here; opponents stay ${Math.round(this.match?.ruleset.wallDistance ?? 0)} px away.`
    } else if (key === 'offside') {
      why = 'A forward was in an illegal position when their teammate played the ball.'
      restriction = 'The defending side restarts from the offside spot; the restart is indirect.'
    } else if (key === 'penalty') {
      const culprit = this.lastRuleWhistle?.kind === 'foul' ? this.teams[this.lastRuleWhistle.offender].name : other
      why = `${culprit} committed a foul inside the defending penalty area.`
      restriction = 'The taker gets one flick from the spot. The keeper follows the keeper-line rule shown for this match.'
    }
    this.pendingRuleHint = key
    this.ui.showRuleHint(makeRuleHint(key, awarded, other, why, restriction))
  }

  private closeRuleHint(): void {
    const key = this.pendingRuleHint
    this.pendingRuleHint = null
    if (key) {
      this.settings.ruleHintsSeen[key] = true
      saveSettings(this.settings)
    }
    if (this.hiddenPenalty && (this.hiddenPenalty.stage === 'cover-keeper' || this.hiddenPenalty.stage === 'cover-shooter')) {
      this.showPenaltyCover()
      return
    }
    this.ui.modal(null)
    this.syncTutorialCoach()
  }

  private onPlayEvent(e: TrackerEvent): void {
    if (e.type === 'pass') { this.refreshMeters(); this.say('pass', {}, 0) }
    if (e.type === 'powerReady') {
      this.refreshMeters()
      this.ui.banner('POWER SHOT READY', this.teams[e.team].primary, 1300)
      this.crowd.chant()
      this.say('powerReady', { team: this.teams[e.team].name }, 2)
    }
    if (e.type === 'boardBonus') { this.ui.banner('OFF THE BOARDS!', this.teams[e.team].primary, 1000); this.say('bonus', { team: this.teams[e.team].name, cap: this.capName(e.capId) }, 2) }
    if (e.type === 'byline') { this.lastOut = { x: e.info.at.x, y: e.info.at.y }; this.outMark = { ...this.lastOut, t0: performance.now() }; this.audio.whistle(false) }
    if (e.type === 'boardHit') this.particles.dust(e.at.x, e.at.y, 6, SURFACES[this.surfaceOfMatch()].dustColor, 0.8, 4)
  }

  private drawRestartZone(ctx: CanvasRenderingContext2D): void {
    const z = this.restartZone
    const m = this.match
    if (!z || !m || (m.phase !== 'aim' && m.phase !== 'reset')) return
    ctx.save()
    ctx.globalAlpha = 0.16
    ctx.fillStyle = this.teams[z.team].primary
    ctx.strokeStyle = '#fff2bd'
    ctx.lineWidth = 4
    ctx.setLineDash([12, 9])
    if (z.kind === 'penalty' && z.end !== null) {
      const y = (PITCH.height - PITCH.penaltyBox.width) / 2
      const x = z.end === 0 ? 0 : PITCH.width - PITCH.penaltyBox.depth
      ctx.fillRect(x, y, PITCH.penaltyBox.depth, PITCH.penaltyBox.width)
      ctx.globalAlpha = 0.8
      ctx.beginPath(); ctx.arc(z.at?.x ?? PITCH.penaltySpot, z.at?.y ?? PITCH.height / 2, 30, 0, Math.PI * 2); ctx.stroke()
    } else if (z.kind === 'goalkick' && z.end !== null) {
      const y = (PITCH.height - PITCH.penaltyBox.width) / 2
      ctx.fillRect(z.end === 0 ? 0 : PITCH.width - PITCH.penaltyBox.depth, y, PITCH.penaltyBox.depth, PITCH.penaltyBox.width)
      ctx.globalAlpha = 0.75
      ctx.strokeRect(z.end === 0 ? 0 : PITCH.width - PITCH.goalBox.depth, (PITCH.height - PITCH.goalBox.width) / 2, PITCH.goalBox.depth, PITCH.goalBox.width)
    } else if (z.kind === 'corner' && z.end !== null) {
      const x = z.end === 0 ? 0 : PITCH.width - 130
      const y = (z.at?.y ?? PITCH.height / 2) < PITCH.height / 2 ? 0 : PITCH.height - 130
      ctx.fillRect(x, y, 130, 130)
    } else if (z.at) {
      ctx.globalAlpha = 0.1
      ctx.beginPath(); ctx.arc(z.at.x, z.at.y, m.ruleset.wallDistance, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 0.85
      ctx.beginPath(); ctx.arc(z.at.x, z.at.y, 28, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }

  /** Chalk ring + cross where the ball went out, so the corner / goal kick call is readable. */
  private outMark: { x: number; y: number; t0: number } | null = null
  private lastOut: { x: number; y: number } | null = null
  private drawOutMark(ctx: CanvasRenderingContext2D): void {
    const o = this.outMark
    if (!o) return
    const t = (performance.now() - o.t0) / 1800
    if (t >= 1 || this.match?.phase === 'replay') { if (t >= 1) this.outMark = null; return }
    const a = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25
    ctx.save()
    ctx.globalAlpha = a
    ctx.strokeStyle = '#fff6d8'
    ctx.lineWidth = 4
    ctx.setLineDash([7, 5])
    ctx.beginPath(); ctx.arc(o.x, o.y, 22 + 10 * Math.min(1, t * 4), 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = '#ff4d1a'
    ctx.lineWidth = 5
    ctx.beginPath(); ctx.moveTo(o.x - 10, o.y - 10); ctx.lineTo(o.x + 10, o.y + 10); ctx.moveTo(o.x + 10, o.y - 10); ctx.lineTo(o.x - 10, o.y + 10); ctx.stroke()
    ctx.restore()
  }

  private surfaceOfMatch(): SurfaceId { return this.match?.world.surface.id ?? this.surface }

  private onWin(team: TeamIndex | null, goals: [number, number], reason: 'target' | 'time' | 'shootout'): void {
    this.audio.whistle(true)
    this.crowd.swell(team === null ? 0.4 : 0.9, 4)
    this.ui.setTurn(null, this.teams, '')
    const d = this.teams
    this.say(team === null ? 'draw' : 'win', { team: team === null ? '' : d[team].name, score: `${goals[0]}–${goals[1]}` }, 3)
    let actions = '<button class="btn" data-action="restart">Rematch</button><button class="btn ghost" data-action="newmatch">New match</button>'
    let title = team === null ? 'Honours even' : `${d[team].name} win!`
    if (this.mode === 'online') actions = '<button class="btn ghost" data-action="online:leave">Leave room</button>'
    if (this.mode === 'tournament' && this.currentTie) {
      if (team === null) {
        // Level after a timed match: straight to penalties.
        this.pendingTie = { tie: this.currentTie, goals }
        title = 'Level — penalties!'
        actions = '<button class="btn" data-action="tie-shootout">To the spot</button>'
      } else {
        const tie = this.currentTie
        const pend = this.pendingTie
        if (pend && pend.tie === tie) this.tournament!.record(tie.id, pend.goals, team, goals)
        else this.tournament!.record(tie.id, goals, team)
        this.pendingTie = null
        this.currentTie = null
        this.simulateAiOnlyTies()
        const champion = this.tournament!.champion
        if (champion !== null) {
          const eliminated = this.aiTournament && champion !== 0
          title = eliminated ? 'Your run ends here' : `${d[team].name} are champions!`
          actions = `<button class="btn" data-action="cup">${eliminated ? 'See who lifts the cup' : 'Lift the cup'}</button>`
        } else {
          actions = '<button class="btn" data-action="bracket">Continue</button>'
        }
      }
    }
    const stats = this.matchStatistics.snapshot()
    const modeLabels: Record<Mode, string> = {
      quick: 'Quick Match', ai: 'Street match vs AI', shootout: 'Penalty Shootout',
      tournament: this.mode === 'tournament' && this.aiTournament ? 'Street Tournament · Versus AI' : 'Street Tournament',
      online: 'Online Match', tutorial: 'Guided tutorial',
    }
    this.summaryActions = actions
    this.matchSummary = {
      headline: title,
      teams: [d[0].name, d[1].name],
      score: [goals[0], goals[1]],
      scoreLabel: reason === 'shootout' ? 'Penalty shootout score' : 'Final score',
      mode: modeLabels[this.mode],
      duration: fmtClock(Math.floor(stats.elapsedMs / 1000)),
      color: team === null ? '#888888' : d[team].primary,
      stats: [
        { label: 'Flicks', values: stats.flicks },
        { label: 'Power shots', values: stats.powerShots },
        { label: 'Completed passes', values: stats.passes },
        { label: 'Board bonuses', values: stats.boardBonuses },
      ],
      replayAvailable: this.lastGoalReplay !== null,
    }
    this.showMatchSummary()
    if (team !== null) this.particles.confetti(PITCH.width / 2, PITCH.height / 2, team === 0 ? 1 : -1, 160, [d[team].primary, d[team].secondary, '#fff'])
  }

  private onContact(c: Contact): void {
    const st = c.a.kind === 'static' ? c.a : c.b.kind === 'static' ? c.b : null
    const hasBall = c.a.kind === 'ball' || c.b.kind === 'ball'
    const surf = SURFACES[this.surfaceOfMatch()]
    if (st && st.kind === 'static') {
      this.audio.impact(st.board === 'post' ? 'post' : st.board === 'net' ? 'net' : 'board', c.impact)
      if (st.board === 'post' && hasBall && c.impact > 3) { this.crowd.ooh(); this.say('post', {}, 2) }
    } else {
      this.audio.impact(hasBall ? 'ball' : 'cap', c.impact)
      if (!hasBall && c.impact > 14) { this.say('bigHit', {}, 1); this.crowd.swell(0.35, 1.5) }
    }
    if (this.replay) return
    // Dust and shake scale with the hit.
    const n = Math.min(12, Math.round(c.impact * 0.5 * (0.3 + surf.dust)))
    if (n > 0) this.particles.dust(c.x, c.y, n, surf.dustColor, 0.4 + c.impact * 0.05, 3 + c.impact * 0.15)
    if (c.impact > 8) this.shake.add((c.impact - 8) * FX.shakePerImpact)
  }

  /** Per fixed-step batch: sliding dust and the power-shot fire trail. */
  private onStep(dtMs: number): void {
    const m = this.match
    if (!m) return
    const surf = SURFACES[this.surfaceOfMatch()]
    const k = dtMs / 16.67
    if (surf.dust > 0) {
      for (const b of m.world.dynamic) {
        const sp = b.speed
        if (sp < 2.5) continue
        if (Math.random() < Math.min(1, sp * 0.03 * surf.dust * k)) this.particles.dust(b.position.x, b.position.y, 1, surf.dustColor, 0.25, 3 + sp * 0.12)
      }
    }
    if (m.powerShotLive && m.activeCap !== null) {
      const b = m.world.caps[m.activeCap]
      if (b.speed > 1.5) for (let i = 0; i < 2; i++) this.particles.fire(b.position.x, b.position.y, b.velocity.x, b.velocity.y)
    }
  }

  /** Speak + caption a commentary line. Returns true if a line was delivered. */
  private say(kind: CallKind, vars: CallVars, priority: number): boolean {
    if (!this.settings.commentary || !this.live) return false
    const line = this.commentator.call(kind, vars, performance.now(), priority)
    if (!line) return false
    this.ui.caption(line, priority >= 3 ? 3200 : 2400)
    this.voice.say(line, priority >= 3)
    return true
  }

  // ---------------------------------------------------------------- HUD bits
  private refreshMeters(): void {
    const m = this.match
    if (!m) { this.ui.html('[data-meters]', ''); return }
    if (m.shootout) {
      const so = m.shootout
      const html = ([0, 1] as const).map(t => {
        const n = Math.max(so.rounds, so.taken(t))
        const dots = Array.from({ length: n }, (_, i) => {
          const k = so.kicks[t][i]
          return `<span class="kick ${k === undefined ? '' : k ? 'scored' : 'missed'}"></span>`
        }).join('')
        return `<div class="meter" style="--team:${this.teams[t].primary}"><span>${esc(this.teams[t].name)}</span><span class="kicks">${dots}</span></div>`
      }).join('')
      this.ui.html('[data-meters]', html)
      return
    }
    if (!m.ruleset.combos.enabled) { this.ui.html('[data-meters]', ''); return }
    const need = m.ruleset.combos.passesForPowerShot
    const html = ([0, 1] as const).map(t => {
      const d = this.teams[t]
      const ready = m.possession.powerReady[t]
      const n = ready ? need : m.possession.chain[t]
      const pips = Array.from({ length: need }, (_, i) => `<span class="pip ${i < n ? 'on' : ''}"></span>`).join('')
      return `<div class="meter ${ready ? 'ready' : ''}" style="--team:${d.primary}"><span>${esc(d.name)}</span><span class="pips">${pips}</span>${ready ? '<b>POWER!</b>' : ''}</div>`
    }).join('')
    this.ui.html('[data-meters]', html)
  }

  /** Contextual centre button: power shot (open play) or "lock keeper" (shootout). */
  private refreshActionButton(): void {
    const m = this.match
    if (!m || !this.live) { this.ui.html('[data-powerbtn]', ''); return }
    if (this.hiddenPenalty?.stage === 'keeper') {
      if (this.aiSetPieceTurn()) { this.ui.html('[data-powerbtn]', '<button class="powerbtn" disabled>AI KEEPER PICKING</button>'); return }
      this.ui.html('[data-powerbtn]', '<button class="powerbtn" data-action="keeper-lock">LOCK KEEPER</button>')
      return
    }
    if (this.hiddenPenalty?.stage === 'shooter') {
      if (this.aiSetPieceTurn()) { this.ui.html('[data-powerbtn]', '<button class="powerbtn" disabled>AI TAKER STEPPING UP</button>'); return }
      const ready = !!this.hiddenPenalty.candidateShot
      this.ui.html('[data-powerbtn]', `<div class="penalty-lock-actions"><button class="powerbtn" data-action="shot-lock" ${ready ? '' : 'disabled'}>LOCK SHOT</button><button class="powerbtn penalty-concede" data-action="penalty-concede">CONCEDE</button></div>`)
      return
    }
    if (this.mode === 'online' && this.onlinePenaltyId !== -1) {
      const label = this.onlinePenaltyCommitted
        ? (this.onlinePenaltyStage === 'reveal' ? 'LOCKED · REVEALING' : 'LOCKED · WAITING FOR MATE')
        : 'WAITING FOR THE REVEAL'
      this.ui.html('[data-powerbtn]', `<button class="powerbtn" disabled>${label}</button>`)
      return
    }
    if (m.keeperSetting) {
      if (this.aiSetPieceTurn()) { this.ui.html('[data-powerbtn]', '<button class="powerbtn" disabled>AI KEEPER PICKING</button>'); return }
      this.ui.html('[data-powerbtn]', '<button class="powerbtn" data-action="keeperready">LOCK KEEPER</button>')
      return
    }
    if (!m.canArm(m.team)) { this.ui.html('[data-powerbtn]', ''); return }
    const armed = m.armed === m.team
    this.ui.html('[data-powerbtn]', `<button class="powerbtn ${armed ? 'armed' : ''}" data-action="arm">${armed ? 'POWER SHOT ARMED' : 'USE POWER SHOT'}</button>`)
  }

  /** Re-render power UI after external state changes (dev/test hook). */
  refreshPowerButtonPublic(): void { this.refreshMeters(); this.refreshActionButton() }

  private isAiTurn(m: Match | null = this.match): boolean {
    // Any match with an AI brain (standalone or Versus-AI tournament) plays team 1.
    // Hidden penalties are staged by their own flow, so the normal flick AI stays out.
    return !!m && !!this.aiBrain && this.live && m.team === 1 && m.phase === 'aim' && !m.keeperSetting && !this.hiddenPenalty
  }

  private cancelAi(): void {
    this.aiEpoch++
    if (this.aiBusy || this.aiDecision || this.aiThinkMs > 0 || this.aiDragMs > 0) this.aim = null
    this.aiThinkMs = 0
    this.aiDragMs = 0
    this.aiKeeperMs = 0
    this.aiBusy = false
    this.aiDecision = null
  }

  private scheduleAi(m: Match | null): void {
    this.cancelAi()
    if (!m || !this.isAiTurn(m)) return
    this.aiThinkMs = AI.thinkMs
    this.ui.caption(`${AI.levels[this.settings.aiLevel].name} is sizing it up…`, AI.thinkMs + 1000)
  }

  private async thinkForAi(m: Match): Promise<void> {
    const brain = this.aiBrain
    if (!brain) return
    const epoch = this.aiEpoch
    this.aiBusy = true
    try {
      const decision = await brain.decide(captureBoard(m), () => epoch !== this.aiEpoch || this.match !== m || !this.isAiTurn(m), 1)
      if (epoch !== this.aiEpoch || this.match !== m || !this.isAiTurn(m)) return
      if (!decision) { this.scheduleAi(m); return }
      this.aiDecision = decision
      this.aiDragMs = AI.dragMs
    } catch (error) {
      console.error('CAPBALL AI could not finish its rehearsal', error)
      if (epoch === this.aiEpoch && this.match === m && this.isAiTurn(m)) this.scheduleAi(m)
    } finally {
      if (epoch === this.aiEpoch) this.aiBusy = false
    }
  }

  private advanceAi(m: Match, dt: number): void {
    if (!this.isAiTurn(m) || m.paused || this.ui.modalOpen) return
    if (!this.aiDecision && !this.aiBusy) {
      if (this.aiThinkMs > 0) this.aiThinkMs = Math.max(0, this.aiThinkMs - dt)
      if (this.aiThinkMs === 0) void this.thinkForAi(m)
      return
    }
    const decision = this.aiDecision
    if (!decision) return
    this.aiDragMs = Math.max(0, this.aiDragMs - dt)
    const cap = m.world.caps[decision.capId]
    const info = m.world.capInfo(decision.capId)
    const origin = { x: cap.position.x, y: cap.position.y }
    const drag = INPUT.minDrag + decision.power * (INPUT.maxDrag - INPUT.minDrag)
    const pointer: Vec = { x: origin.x - decision.dir.x * drag, y: origin.y - decision.dir.y * drag }
    this.aim = { capId: decision.capId, origin, pointer, dir: decision.dir, drag, power: decision.power, valid: true, capped: decision.power >= 1, spin: decision.spin, grab: { x: 0, y: 0 }, grabR: info.type.radius }
    if (this.aiDragMs > 0) return
    this.aiDecision = null
    this.aim = null
    if (decision.arm && m.canArm(m.team)) m.toggleArm()
    if (!m.tryFlick(decision.capId, decision.dir, decision.power, decision.spin)) this.scheduleAi(m)
  }

  /** Shootout: the AI keeper picks its spot and locks it without a human tap. */
  private advanceAiKeeper(m: Match, dt: number): void {
    if (!this.aiBrain || !m.keeperSetting || m.team !== 1) return
    if (!this.live || m.paused || this.ui.modalOpen) return
    if (this.aiKeeperMs === 0) {
      m.slideKeeper(this.aiBrain.keeperGuess())
      this.aiKeeperMs = AI.thinkMs + 250
      this.ui.caption(`${this.teams[1].name} keeper is picking a spot…`, 1400)
      return
    }
    this.aiKeeperMs = Math.max(0, this.aiKeeperMs - dt)
    if (this.aiKeeperMs === 0) m.keeperReady()
  }

  /** The AI owns this keeper/shot choice; the human must not click or drag it. */
  private aiSetPieceTurn(m: Match | null = this.match): boolean {
    if (!m || !this.aiBrain) return false
    if (m.keeperSetting) return m.team === 1
    return !!this.hiddenPenalty && this.hiddenPenalty.stage === 'shooter' && this.hiddenPenalty.kicker === 1
  }

  // ---------------------------------------------------------------- input
  private localRuleInputActive(): boolean {
    const m = this.match
    return !!m && this.live && (this.mode === 'quick' || this.mode === 'tournament')
      && m.phase === 'aim' && !m.paused && !this.ui.modalOpen && m.ruleset.freeKicks
      && !this.hiddenPenalty && this.ui.root.dataset.current === 'hud'
  }

  private pickable() {
    const m = this.match
    if (!m || !this.live || m.phase !== 'aim' || m.paused || this.ui.modalOpen || this.ui.root.dataset.current !== 'hud' || this.isAiTurn(m) || this.aiSetPieceTurn(m)) return []
    if (this.hiddenPenalty && this.hiddenPenalty.stage !== 'shooter') return []
    if (this.mode === 'online' && (!this.onlineState?.ready || this.onlineClient?.state !== 'open' || this.onlineTeam !== m.team)) return []
    return m.world.caps
      .map((b, id) => ({ b, id, info: m.world.capInfo(id) }))
      .filter(c => m.canPick(c.id) && (this.mode !== 'tutorial' || (c.info.team === 0 && (this.tutorialPickCapId === null || c.id === this.tutorialPickCapId))))
      .map(c => ({ id: c.id, x: c.b.position.x, y: c.b.position.y, r: c.info.type.radius }))
  }

  private onAim(a: FlickAim | null): void {
    const m = this.match
    if (m?.keeperSetting) {
      // Shootout keeper: dragging slides it along the goal line instead of aiming.
      if (a && !this.aiSetPieceTurn(m)) m.slideKeeper(a.pointer.y)
      this.aim = null
      this.ui.setAimPower(null)
      return
    }
    this.aim = a
    this.ui.setAimPower(a)
  }

  // ---------------------------------------------------------------- UI actions
  private onAction(a: string, el: HTMLElement): void {
    this.audio.unlock()
    if (!a.startsWith('input:')) this.audio.ui()
    const [cmd, arg = ''] = a.split(/:(.*)/s)
    switch (cmd) {
      case 'mode':
        this.mode = arg as Mode
        this.tournament = null
        this.currentTie = null
        this.pendingTie = null
        this.tutorialGuide = null
        this.tutorialStageSignature = ''
        this.ui.setTutorialCoach(null)
        if (this.mode === 'quick' && !this.settings.tutorialPrompted) this.ui.showTutorialPrompt()
        else if (this.mode === 'online') this.openOnline()
        else this.openSetup()
        break
      case 'tutorial':
        if (arg === 'entry') this.startTutorial(this.settings.tutorialStep >= TUTORIAL_COMPLETE_STEP)
        else if (arg === 'learn') this.startTutorial(false)
        else if (arg === 'skip-prompt') this.skipTutorialPrompt()
        else if (arg === 'skip') this.skipTutorialDrill()
        else if (arg === 'retry') this.retryTutorialDrill()
        else if (arg === 'hint') { this.tutorialGuide?.revealHint(); this.syncTutorialCoach() }
        else if (arg === 'pause') this.ui.modal('pause')
        else if (arg === 'leave') this.leaveTutorial()
        else if (arg === 'regular') {
          this.tutorialGuide = null
          this.mode = 'quick'
          this.ui.modal(null)
          this.toMenu()
          this.openSetup()
        } else if (arg === 'done-replay') { this.ui.modal(null); this.startTutorial(true) }
        else if (arg === 'done-menu') { this.tutorialGuide = null; this.mode = 'quick'; this.toMenu() }
        break
      case 'rulehint': if (arg === 'close') this.closeRuleHint(); break
      case 'ai-level':
        if (arg === 'easy' || arg === 'medium' || arg === 'hard') this.settings.aiLevel = arg as AiLevel
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'tournament-ai':
        this.settings.tournamentAi = arg === 'yes'
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'preset':
        this.settings.ruleset = arg
        this.settings.flags = {}
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'penalty-timeout':
        if (arg === 'straight' || arg === 'forfeit') this.settings.penaltyTimeout = arg
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'surface':
        this.settings.surface = arg
        saveSettings(this.settings)
        this.renderer.setSurface(this.surface)
        this.match?.world.setSurface(this.surface)
        if (this.ui.root.dataset.current === 'online') this.openOnline()
        else this.openSetup()
        break
      case 'input':
        if (arg.startsWith('flag:')) {
          this.settings.flags = { ...this.settings.flags, [arg.slice(5)]: (el as HTMLInputElement).checked }
          saveSettings(this.settings)
          this.openSetup()
        } else if (arg.startsWith('team:')) this.editTeam(arg.slice(5), el)
        else if (arg === 'online-code') (el as HTMLInputElement).value = (el as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
        break
      case 'go': this.go(); break
      case 'back': this.toMenu(); break
      case 'editor': this.openEditor(this.ui.root.dataset.current === 'setup' ? 'setup' : 'start'); break
      case 'settings': this.ui.modal('settings'); break
      case 'swatch': {
        const [i, field, color] = arg.split(':')
        this.settings.teams[Number(i)][field as 'primary' | 'secondary'] = color
        this.openEditor(this.editorReturn)
        break
      }
      case 'pattern': {
        const [i, p] = arg.split(':')
        this.settings.teams[Number(i)].pattern = p as TeamDesign['pattern']
        this.openEditor(this.editorReturn)
        break
      }
      case 'teamreset': this.settings.teams[Number(arg) as 0 | 1] = defaultTeam(Number(arg) as 0 | 1); this.openEditor(this.editorReturn); break
      case 'editor-done': this.closeEditor(); break
      case 'toggle':
        if (arg === 'commentary') this.settings.commentary = !this.settings.commentary
        else if (arg === 'speech' && this.voice.available) {
          this.settings.speech = !this.settings.speech
          this.voice.enabled = this.settings.speech
          if (!this.settings.speech) this.voice.stop()
        } else if (arg === 'sound') this.setSound(!this.settings.sound)
        else if (arg === 'dark') { this.settings.dark = !this.settings.dark; this.applyTheme() }
        else if (arg === 'tuning' && this.debugToolsEnabled) this.setTuning(!this.settings.tuning)
        this.syncSettingsPanel()
        saveSettings(this.settings)
        break
      case 'tune': this.tune.toggle(); break
      case 'arm': this.match?.toggleArm(); this.refreshActionButton(); break
      case 'keeperready':
        // The AI sets its own shootout keeper; a human tap must not lock that choice.
        if (!this.aiBrain || this.match?.team === 0) this.match?.keeperReady()
        break
      case 'penalty-cover': this.dismissPenaltyCover(); break
      case 'keeper-lock': this.lockPenaltyKeeper(); break
      case 'shot-lock': this.lockPenaltyShot(); break
      case 'penalty-concede': this.forfeitPenalty(); break
      case 'pause': if (this.match && this.match.phase !== 'over') { this.ui.modal('pause'); if (this.mode === 'online') this.ui.setOnlineDiagnostics(this.onlineClient?.diagnostics() ?? null); this.syncTutorialCoach() }; break
      case 'resume': this.ui.modal(null); this.syncTutorialCoach(); break
      case 'concede-match':
        if (this.mode === 'tutorial') break
        this.confirmAction = 'concede'
        this.ui.$('[data-confirm-title]').textContent = 'Concede the match?'
        this.ui.$('[data-confirm-text]').textContent = 'The other player will be awarded the win.'
        this.ui.modal('confirm')
        break
      case 'skipreplay': this.endReplay(); break
      case 'replay-last-goal': this.playLastGoalReplay(); break
      case 'online-copy': void this.copyOnlineInvite(); break
      case 'online-leave': this.toMenu(); break
      case 'playtie': this.playTie(); break
      case 'tie-shootout': this.tieShootout(); break
      case 'bracket': this.ui.modal(null); this.renderBracket(); break
      case 'cup': this.ui.modal(null); this.renderCup(); break
      case 'restart':
        if (!this.match) return
        if (this.mode === 'online') { this.ui.caption('Leave this room to start a new match.', 2500); break }
        if (this.mode === 'tutorial' && this.tutorialGuide) {
          if (this.match.phase !== 'aim' || !this.match.world.isAtRest()) { this.ui.caption('Let every piece settle before retrying this drill.', 2200); break }
          this.ui.modal(null)
          this.retryTutorialDrill()
          break
        }
        this.ui.modal(null)
        this.matchStatistics.reset()
        this.lastGoalReplay = null
        this.matchSummary = null
        this.summaryActions = ''
        this.ui.$('[data-summary-replay]').hidden = true
        window.clearTimeout(this.penaltyRevealTimer)
        this.penaltyRevealTimer = 0
        this.hiddenPenalty?.finish()
        this.hiddenPenalty = null
        this.ui.setPenaltyTimer(null)
        this.restartZone = null
        this.replay = null
        this.goalHoldMs = -1
        this.ui.$('[data-replay]').hidden = true
        this.ui.html('[data-win-actions]', '<button class="btn" data-action="restart">Rematch</button><button class="btn ghost" data-action="newmatch">New match</button>')
        this.particles.clear()
        this.match.restart()
        this.ui.setScore([0, 0])
        this.refreshMeters()
        this.audio.whistle()
        break
      case 'newmatch': if (this.mode === 'tutorial') this.leaveTutorial(); else this.toMenu(); break
      case 'online':
        if (arg === 'create') void this.connectOnline('')
        else if (arg === 'join') {
          const code = this.ui.$('[data-input="online-code"]') as HTMLInputElement
          if (!/^[A-Z0-9]{4,8}$/.test(code.value)) { this.onOnlineStatus('unavailable', 'Enter a 4–8 character room code.'); break }
          void this.connectOnline(code.value)
        } else if (arg === 'back' || arg === 'leave') this.toMenu()
        else if (arg === 'copy') void this.copyOnlineInvite()
        break
      case 'rules': this.ui.modal('rules'); break
      case 'closemodal': this.confirmAction = null; this.ui.modal(null); break
      case 'confirm-yes': {
        const action = this.confirmAction
        this.confirmAction = null
        this.ui.modal(null)
        if (action === 'concede' && this.match && this.mode !== 'online') this.match.concede((1 - this.match.team) as TeamIndex)
        break
      }
      case 'sound':
        this.setSound(!this.settings.sound)
        saveSettings(this.settings)
        break
    }
  }

  private setSound(on: boolean): void {
    this.settings.sound = on
    this.audio.setEnabled(on)
    if (on) this.crowd.start()
    else this.crowd.stop()
    this.ui.setSound(on)
  }

  private setTuning(on: boolean): void {
    const enabled = on && this.debugToolsEnabled
    this.settings.tuning = enabled
    this.tune.setEnabled(enabled)
    this.ui.$('[data-tune-btn]').hidden = !enabled
    this.ui.setSettingSwitch('tuning', enabled)
  }

  private syncSettingsPanel(): void {
    this.ui.setSettingSwitch('commentary', this.settings.commentary)
    this.ui.setSettingSwitch('speech', this.settings.speech)
    this.ui.setSettingSwitch('sound', this.settings.sound)
    this.ui.setSettingSwitch('dark', this.settings.dark)
    this.ui.setSettingSwitch('tuning', this.settings.tuning && this.debugToolsEnabled)
    this.ui.setSettingAvailable('speech', this.voice.available, 'Voice is unavailable in this browser.')
    this.ui.$('[data-setting-row="tuning"]').hidden = !this.debugToolsEnabled
  }

  /** Theme is one switch: CSS tokens for the chrome, a darker canvas for the pitch. */
  private applyTheme(): void {
    const dark = this.settings.dark
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    this.renderer.setDark(dark)
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) meta.content = dark ? '#0c0b0e' : '#18171b'
  }

  private go(): void {
    const rules = buildRuleset(this.settings.ruleset, this.settings.flags, this.settings.penaltyTimeout)
    if (this.mode === 'quick') this.startMatch(rules, this.surface)
    else if (this.mode === 'ai') this.startMatch(rules, this.surface, { vsAi: true })
    else if (this.mode === 'shootout') this.startMatch(rules, this.surface, { shootout: true })
    else if (this.mode === 'tournament') {
      this.aiTournament = this.settings.tournamentAi
      this.tournamentSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
      this.tournamentRules = rules
      this.tournament = new Tournament(this.aiTournament
        ? [this.settings.teams[0], ...AI_RIVAL_CREWS]
        : [this.settings.teams[0], this.settings.teams[1], ...RIVAL_CREWS])
      this.simulateAiOnlyTies()
      this.renderBracket()
    }
  }

  /** Resolve every ready fixture that does not involve the human's crew (crew 0). */
  private simulateAiOnlyTies(): void {
    const tour = this.tournament
    const rules = this.tournamentRules
    if (!this.aiTournament || !tour || !rules) return
    for (let pass = 0; pass < 3; pass++) {
      let changed = false
      for (const tie of tour.ties) {
        if (tie.result || tie.home === null || tie.away === null) continue
        if (tie.home === 0 || tie.away === 0) continue
        const sim = simulateAiTie(this.tournamentSeed, tie.id, tour.crews[tie.home], tour.crews[tie.away], rules)
        tour.record(tie.id, sim.goals, sim.winnerSide, sim.shootout, true)
        changed = true
      }
      if (!changed) break
    }
  }

  private async copyOnlineInvite(): Promise<void> {
    const room = this.onlineClient?.room
    if (!room) { this.ui.caption('Room code is not ready yet.', 2200); return }
    const invite = new URL(location.href)
    invite.searchParams.set('room', room)
    invite.hash = ''
    try { await navigator.clipboard.writeText(invite.href); this.ui.caption(`Invite copied · room ${room}`, 2600) }
    catch { this.ui.caption(`Room ${room} · invite: ${invite.href}`, 5000) }
  }

  private playTie(): void {
    const tour = this.tournament
    const tie = tour?.next
    if (!tour || !tie || tie.home === null || tie.away === null) return
    this.currentTie = tie
    this.pendingTie = null
    const teams = resolveKits(tour.crews[tie.home], tour.crews[tie.away])
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags, this.settings.penaltyTimeout), this.surface, { teams, vsAi: this.aiTournament })
    this.ui.banner(tie.label.toUpperCase(), '#151515', 1300)
  }

  private tieShootout(): void {
    const tour = this.tournament
    const pend = this.pendingTie
    if (!tour || !pend || pend.tie.home === null || pend.tie.away === null) return
    this.currentTie = pend.tie
    const teams = resolveKits(tour.crews[pend.tie.home], tour.crews[pend.tie.away])
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags, this.settings.penaltyTimeout), this.surface, { shootout: true, teams, vsAi: this.aiTournament })
  }

  private toMenu(): void {
    this.onlineClient?.stop()
    this.onlineState = null
    this.onlineTeam = null
    this.pendingOnlineActions.clear()
    this.ui.setOnlinePauseMode(false)
    this.ui.setOnlineDiagnostics(null)
    this.onlineSmoother.reset()
    this.ui.modal(null)
    this.ui.html('[data-win-actions]', '<button class="btn" data-action="restart">Rematch</button><button class="btn ghost" data-action="newmatch">New match</button>')
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags, this.settings.penaltyTimeout), this.surface, { live: false })
    this.renderStartMenu()
    this.ui.show('start')
  }

  // ---------------------------------------------------------------- frame
  private frame(t: number): void {
    const dt = this.last ? Math.min(100, t - this.last) : 16.7
    this.last = t
    const m = this.match
    if (m) {
      m.paused = this.live && ((this.ui.modalOpen && m.phase !== 'over')
        || (this.mode === 'online' && (!this.onlineState?.ready || this.onlineClient?.state !== 'open')))
      if (!m.paused) this.tick(m, dt)
      if (this.mode === 'online') {
        // Render-only: settle visual corrections, and refresh the pause-sheet readout twice a second.
        this.onlineSmoother.advance(dt)
        this.onlineDiagMs += dt
        if (this.onlineDiagMs >= 500) {
          this.onlineDiagMs = 0
          this.ui.setOnlineDiagnostics(this.onlineClient?.diagnostics() ?? null)
        }
      }
      if (m.ruleset.halves && !m.shootout) {
        const txt = `${m.half}H ${fmtClock(m.timeLeft ?? 0)}`
        if (txt !== this.clockText) { this.clockText = txt; this.ui.setClock(txt) }
      }
      this.renderer.shake = { x: this.shake.x, y: this.shake.y }
      this.renderer.draw(this.frameState(m, t))
    }
    this.raf = requestAnimationFrame(tt => this.frame(tt))
  }

  private tick(m: Match, dt: number): void {
    const s = dt / 1000
    if (this.live && m.phase !== 'over' && !this.replay) this.matchStatistics.advance(dt)
    if (this.replay) {
      this.replay.t += s * FX.replaySpeed
      if (this.replay.t >= this.replay.clip.duration) this.endReplay()
    } else {
      this.advanceHiddenPenalty(dt)
      this.advanceAiKeeper(m, dt)
      this.advanceAi(m, dt)
      m.update(dt)
    }
    if (this.goalHoldMs >= 0 && m.phase === 'goal') {
      this.goalHoldMs += dt
      if (this.goalHoldMs >= FX.celebrateMs) { this.goalHoldMs = -1; this.startReplay() }
    } else if (m.phase !== 'goal') this.goalHoldMs = -1
    this.particles.update(s * (this.replay ? FX.replaySpeed : 1))
    this.shake.update(s, this.settings.shake)
    // Crowd tension follows how close the ball is to either goal.
    this.crowdTimer += dt
    if (this.crowdTimer > 300) {
      this.crowdTimer = 0
      const bx = m.world.ball.position.x
      const near = Math.max(0, 1 - Math.min(bx, PITCH.width - bx) / 260)
      this.crowd.setExcitement(this.live ? near : 0)
    }
  }

  private frameState(m: Match, t: number): FrameState {
    const rp = this.replay
    const online = this.mode === 'online' && this.live && !rp
    const caps: CapView[] = m.world.caps.map((b, id) => {
      const info = m.world.capInfo(id)
      const p = rp ? rp.clip.pose(rp.t, id) : { x: b.position.x, y: b.position.y, angle: b.angle }
      const pose = online ? this.onlineSmoother.apply(id, p) : p
      return { x: pose.x, y: pose.y, angle: pose.angle, team: info.team, slot: info.slot, type: info.type.id, active: m.world.isActive(b) }
    })
    const rawBall = rp ? rp.clip.pose(rp.t, m.world.caps.length) : { x: m.world.ball.position.x, y: m.world.ball.position.y, angle: m.world.ball.angle }
    const ball = online ? this.onlineSmoother.apply(m.world.caps.length, rawBall) : rawBall
    return {
      caps,
      ball,
      aim: this.aim,
      pickTeam: this.live && m.phase === 'aim' && !m.paused && !this.aiSetPieceTurn(m) && (!this.hiddenPenalty || this.hiddenPenalty.stage === 'shooter') ? m.team : null,
      pickable: this.live && m.phase === 'aim' ? (id: number) => !this.isAiTurn(m) && !this.aiSetPieceTurn(m) && (!this.hiddenPenalty || this.hiddenPenalty.stage === 'shooter') && m.canPick(id) : undefined,
      powerShot: m.armed !== null && m.armed === m.team && m.phase === 'aim',
      activeCap: m.activeCap,
      replay: !!rp,
      time: t,
    }
  }

  /** Live handler counts — used by the smoke test to prove nothing stacks up across matches. */
  debugCounts(): Record<string, number> {
    return { input: activeInputHandlers(), penaltyInput: activePenaltyInputHandlers(), matchListeners: this.match?.events.listenerCount() ?? 0, matchSubs: this.matchUnsubs.length, overlays: activeOverlays(), overlaySubs: this.tune.listenerCount }
  }

  /** Online responsiveness readout for the smoke test. Local measurements only, never player input. */
  debugOnline(): Record<string, unknown> {
    let residual = 0
    for (let id = 0; id < 11; id++) residual = Math.max(residual, this.onlineSmoother.residualPx(id))
    return {
      ...(this.onlineClient?.diagnostics() ?? {}),
      link: this.onlineClient?.state ?? 'idle',
      ready: this.onlineState?.ready ?? false,
      team: this.onlineTeam,
      pendingPredictions: this.pendingOnlineActions.size,
      smoother: { ...this.onlineSmoother.stats, residualPx: Math.round(residual * 10) / 10 },
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.endMatch()
    this.crowd.stop()
    this.input.detach()
    this.keeperInput.detach()
    this.ruleGestureGuard.detach()
    this.tune.destroy()
    this.resizeObs.disconnect()
    this.abort.abort()
    this.ui.destroy()
  }
}

export function fmtClock(sec: number): string {
  const s = Math.ceil(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function rulesHtml(r: Ruleset, surface: SurfaceId, shootout = false): string {
  const s = SURFACES[surface]
  const flick = '<h3>The flick</h3><p>Press one of your caps, drag <b>back</b> like a slingshot and let go. The arrow shows direction, the ring shows power. Tiny drags cancel; long drags are capped at max power. Grab off-centre to curl it.</p>'
  if (shootout) {
    return `
      <p><b>Penalty shootout</b> on <b>${esc(s.name)}</b> — ${esc(s.blurb)}</p>
      ${flick}
      <h3>Each kick</h3>
      <p>The keeper's player drags their keeper along the goal line and locks it. Then the taker gets one flick. Whole ball over the line between the posts = goal.</p>
      <p>Five kicks each, then sudden death. Every cap takes a turn: striker, winger, both defenders — and then the keeper.</p>`
  }
  const on: string[] = []
  if (r.spin) on.push('<p><b>Spin.</b> Grab your cap off-centre to put spin on it — it bends the way it spins (grab the right side of your line, it curls left). The arrow bends and a blue arc shows the spin. Grab the middle for a dead-straight flick.</p>')
  if (r.deadBallTurns > 0) on.push(`<p><b>Stuck ball.</b> Ball jammed in a corner or pinned on the boards for ${r.deadBallTurns} plays? The ref drops it back in toward the centre.</p>`)
  if (r.boardBonus) on.push('<p><b>Boards are a teammate.</b> Bounce the ball off a board and onto one of your own caps and you get a bonus flick.</p>')
  if (r.combos.enabled) on.push(`<p><b>Pass combos.</b> Every time the ball goes from one of your caps to another, your meter fills. ${r.combos.passesForPowerShot} passes charge a power shot (×${r.combos.powerMultiplier} punch) — arm it with the button before you flick. The other team touching the ball resets your chain.</p>`)
  if (r.freeKicks) on.push(`<p><b>Free kicks.</b> If your flicked cap hits an opponent before it touches the ball, it's a foul: free kick where it happened, defenders back ${Math.round(r.wallDistance)} units.${r.penalties ? ' In your own box it\'s a penalty.' : ''}</p>`)
  if (r.advantage) on.push('<p><b>Advantage.</b> After a foul, play continues briefly if the fouled team can attack. If they do not make clear forward progress, the referee brings play back for the free kick or penalty.</p>')
  if (r.corners) on.push(r.outBy === 'lastTouch'
    ? '<p><b>Corners &amp; goal kicks.</b> The ball smashing into the board beside a goal is out (soft rolls play on); the ref marks the spot. Real-football rule: the team that touched it <b>last</b> gives it up. Last touch by the defending team: corner to the attackers. Last touch by the attackers: goal kick.</p>'
    : '<p><b>Corners &amp; goal kicks.</b> The ball smashing into the board beside a goal is out (soft rolls play on); the ref marks the spot. Whoever\'s <b>flick</b> sent it out gives it up — deflections don\'t count. Your flick sends it into <b>their</b> end: goal kick to them, everyone back in formation. Your flick sends it into <b>your own</b> end: corner to them, both teams line up in the box.</p>')
  if (r.offside) on.push('<p><b>Offside.</b> A team-mate past the ball and the second-last defender (in the other half) when you flick is offside if the ball reaches them.</p>')
  if (r.goalKickRestriction) on.push('<p><b>Goal kicks.</b> Both teams reset to formation; the keeper takes the kick with the ball straight ahead inside the goal area. Opponents wait outside the penalty area until the ball leaves; if it settles inside, the kick is retaken.</p>')
  if (r.keeperBox) on.push('<p><b>Keeper box.</b> A goalkeeper pushed outside its own penalty area is returned inside after the play settles.</p>')
  if (r.hiddenPenalties) on.push('<p><b>Hidden penalties.</b> On local two-player penalties, the keeper and shooter choose in separate covered turns. Neither sees the other choice until both lock in. Each choice has a countdown; shooter timeout follows your selected Straight Shot or Forfeit rule.</p>')
  const types = r.capTypes ? `<h3>Your crew</h3><div class="types">${(['keeper', 'defender', 'winger', 'striker'] as const).map(k => `<div class="type"><b>${CAP_TYPES[k].label}</b>${CAP_TYPES[k].blurb}</div>`).join('')}</div>` : ''
  return `
    <p><b>${esc(r.name)}</b> on <b>${esc(s.name)}</b> — ${esc(s.blurb)}</p>
    ${flick}
    <h3>Turns</h3>
    <p>One flick per turn. The next player goes only once every cap and the ball have stopped dead.</p>
    <h3>Scoring</h3>
    <p>The whole ball must cross the line between the posts. ${r.goalsToWin ? `First to ${r.goalsToWin} wins.` : ''}${r.halves ? ` ${r.halves.count} halves of ${fmtClock(r.halves.seconds)} — the clock only runs during live turns.` : ''} The team that concedes kicks off. Goals get a slow-motion replay — tap to skip.</p>
    ${types}
    ${on.length ? `<h3>House rules</h3>${on.join('')}` : ''}`
}
