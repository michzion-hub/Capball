import { Audio } from './audio/audio'
import { Commentator, Voice } from './audio/commentary'
import type { CallKind, CallVars } from './audio/commentary'
import { Crowd } from './audio/crowd'
import { RULESETS } from './config/rulesets'
import type { Ruleset } from './config/rulesets'
import { AI, CAP_TYPES, FX, INPUT, PITCH, SURFACES } from './config/tuning'
import type { AiLevel, SurfaceId } from './config/tuning'
import { AiBrain, captureBoard } from './ai/brain'
import type { Decision } from './ai/brain'
import { Particles, Shake } from './fx/effects'
import { Match } from './game/match'
import type { TrackerEvent, Whistle } from './game/play'
import { ReplayRecorder } from './game/replay'
import type { ReplayClip } from './game/replay'
import { RIVAL_CREWS, Tournament } from './game/tournament'
import type { Tie } from './game/tournament'
import type { TurnReason } from './game/turns'
import { TuneOverlay, activeOverlays } from './debug/overlay'
import { FlickInput, activeInputHandlers } from './input/flick'
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
import { OnlineClient } from './net/client'
import type { LinkState } from './net/client'
import type { FlickMessage, NetworkState, ServerMessage } from './net/protocol'

export const TURN_LABEL: Record<TurnReason, string> = {
  kickoff: 'kick off', normal: 'your flick', bonus: 'BONUS FLICK!', freekick: 'free kick', penalty: 'penalty!',
  corner: 'corner', goalkick: 'goal kick', dropball: 'dropped ball', offside: 'free kick (offside)', halftime: 'second half',
  keeper: 'slide your keeper', shootout: 'take the penalty',
}

type Mode = 'quick' | 'ai' | 'shootout' | 'tournament' | 'online'

interface ReplayState { clip: ReplayClip; t: number }

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
  readonly tune: TuneOverlay
  settings: Settings
  match: Match | null = null
  ruleset: Ruleset
  mode: Mode = 'quick'
  /** Crews in the current match (tournament crews or the two designs, kit-resolved). */
  teams: [TeamDesign, TeamDesign]
  tournament: Tournament | null = null
  private currentTie: Tie | null = null
  /** Tied tournament match waiting for its shootout. */
  private pendingTie: { tie: Tie; goals: [number, number] } | null = null
  private aim: FlickAim | null = null
  private aiBrain: AiBrain | null = null
  private aiEpoch = 0
  private aiThinkMs = 0
  private aiDragMs = 0
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

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas
    this.settings = loadSettings()
    this.teams = resolveKits(this.settings.teams[0], this.settings.teams[1])
    this.ruleset = buildRuleset(this.settings.ruleset, this.settings.flags)
    this.renderer = new Renderer(canvas, this.teams)
    this.renderer.layers.push(ctx => this.particles.draw(ctx, [0]))
    this.renderer.overLayers.push(ctx => this.particles.draw(ctx, [1, 2]))
    this.renderer.overLayers.push(ctx => this.tune.drawWorld(ctx, this.renderer.view))
    this.renderer.overLayers.push(ctx => this.drawOutMark(ctx))
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
    this.audio.setEnabled(this.settings.sound)
    this.audio.onReady = () => { if (this.settings.sound) this.crowd.start() }
    this.voice.enabled = this.settings.speech
    this.ui.setSound(this.settings.sound)
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
    const s = this.settings
    this.ui.html('[data-start-menu]', `
      <button class="btn" data-action="mode:quick">Quick match</button>
      <button class="btn ghost" data-action="mode:ai">Play the AI</button>
      <button class="btn ghost" data-action="mode:online">Online · invite a mate</button>
      <button class="btn ghost" data-action="mode:shootout">Penalty shootout</button>
      <button class="btn ghost" data-action="mode:tournament">Street tournament</button>
      <button class="chip" data-action="editor">Design your caps</button>
      <div class="start-toggles">
        <button class="chip ${s.commentary ? '' : 'is-off'}" data-action="toggle:commentary">Commentary ${s.commentary ? 'on' : 'off'}</button>
        ${this.voice.available ? `<button class="chip ${s.speech ? '' : 'is-off'}" data-action="toggle:speech">Voice ${s.speech ? 'on' : 'off'}</button>` : ''}
        <button class="chip ${s.tuning ? '' : 'is-off'}" data-action="toggle:tuning">Tuning tools ${s.tuning ? 'on' : 'off'}</button>
      </div>`)
  }

  private openOnline(): void {
    const sharedRoom = new URL(location.href).searchParams.get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) ?? ''
    this.ui.html('[data-online]', `<div class="online-card">
      <span class="kicker">Street league · no accounts</span><h2>Bring a mate</h2>
      <p>Create a private room link, or punch in the code your mate sent. Both players flick the same match; the room server settles every bounce and call.</p>
      <button class="btn" data-action="online:create">Create room</button>
      <label class="online-code"><span>Room code</span><input data-input="online-code" value="${esc(sharedRoom)}" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="e.g. 7K4M2B"></label>
      <button class="btn ghost" data-action="online:join">Join room</button>
      <p class="online-status" data-online-status role="status">Online rooms need the CAPBALL game server.</p>
      <button class="chip" data-action="online:back">Back to menu</button>
    </div>`)
    this.ui.show('online')
    if (sharedRoom) void this.connectOnline(sharedRoom)
  }

  private async connectOnline(room: string): Promise<void> {
    this.onlineState = null
    this.onlineTeam = null
    this.lastOnlineGoalSeq = 0
    this.pendingOnlineActions.clear()
    await this.onlineClient?.connect(room)
  }

  private onOnlineStatus(state: LinkState, detail?: string): void {
    const status = this.ui?.root.querySelector<HTMLElement>('[data-online-status]')
    if (status) status.textContent = detail ?? ({ discovering: 'Finding the CAPBALL game server…', connecting: 'Joining the room…', open: 'Connected — warming up the pitch…', retrying: 'Reconnecting to the room…', unavailable: 'Online is not configured in this build yet.', closed: 'Room connection closed.', idle: '' }[state])
    if (this.ui?.root.dataset.current === 'hud' && (state === 'retrying' || state === 'unavailable' || state === 'closed')) this.ui.caption(detail ?? 'Room connection lost.', 5000)
  }

  private onOnlineMessage(message: ServerMessage): void {
    if (message.type === 'welcome') {
      this.mode = 'online'
      this.onlineTeam = message.role === 'p1' ? 0 : 1
      this.startMatch(RULESETS.street, 'park', { online: true, teams: [defaultTeam(0), defaultTeam(1)] })
      this.ui.$('[data-local-restart]').hidden = true
      this.ui.$('[data-online-copy]').hidden = false
      this.ui.$('[data-online-leave]').hidden = false
      this.ui.caption(`Room ${message.room} · you're ${message.role === 'p1' ? 'Gutter Kings' : 'Rooftop Rats'}. Share the invite link.`, 6000)
      this.applyOnlineState(message.state)
      return
    }
    if (message.type === 'state') { this.applyOnlineState(message.state); return }
    if (message.type === 'flick') { this.applyOnlineFlick(message); return }
    if (message.type === 'event') {
      if (message.seq <= this.lastOnlineGoalSeq) return
      this.lastOnlineGoalSeq = message.seq
      if (message.kind === 'goal' && message.team !== null) this.onGoal(message.team, message.end ?? (message.team === 0 ? 1 : 0), !!message.ownGoal, message.score, message.capId ?? null)
      else if (message.kind === 'win') this.onWin(message.team, message.score, 'target')
      return
    }
    if (message.type === 'error') this.ui.caption(message.message, 4000)
  }

  private applyOnlineState(state: NetworkState): void {
    if (!this.match || this.onlineTeam === null) return
    const previous = this.onlineState
    this.onlineState = state
    const m = this.match
    if (state.ready && state.phase !== 'waiting') {
      m.applyAuthoritativeState({
        bodies: { caps: state.bodies.slice(0, 10), ball: state.bodies[10] },
        phase: state.phase as Match['phase'], team: state.team, reason: state.reason as TurnReason,
        turn: state.turn, flicks: state.flicks, score: [...state.score], possession: state.possession,
        armed: state.armed, activeCap: state.activeCap,
      })
      m.paused = false
      this.ui.setScore(state.score)
      this.ui.setTurn(state.phase === 'over' ? null : state.team, this.teams, TURN_LABEL[state.reason as TurnReason] ?? 'your flick')
      if (state.phase === 'aim' && (!previous || previous.phase !== state.phase || previous.team !== state.team || previous.turn !== state.turn || previous.reason !== state.reason)) this.onTurn(state.team, state.reason as TurnReason)
      this.refreshMeters()
      this.refreshActionButton()
    } else {
      m.paused = true
      this.ui.setTurn(null, this.teams, '')
      this.ui.caption(state.connected.some(Boolean) ? `Room ${state.room} · waiting for your mate…` : 'Room paused · reconnecting both players…', 7000)
    }
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
    const arm = m.armed === m.team
    if (!m.tryFlick(id, dir, power, spin)) return
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
    this.ui.html('[data-setup]', setupHtml({
      title: m === 'quick' ? 'Quick match' : m === 'ai' ? 'CAPBALL vs the machine' : m === 'shootout' ? 'Penalty shootout' : 'Street tournament',
      sub: m === 'quick' ? 'Pass the phone, take turns, talk trash.'
        : m === 'ai' ? 'One human. One mouthy computer. Pick its street cred.'
          : m === 'shootout' ? 'Five kicks each, then sudden death. Every cap takes one — even the keeper.'
          : 'Four crews, two semis, one final. Draws go to penalties.',
      presetId: this.settings.ruleset, overrides: this.settings.flags, surface: this.surface, showRules: m !== 'shootout',
      showAi: m === 'ai', aiLevel: this.settings.aiLevel,
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

  private renderBracket(): void {
    const tour = this.tournament!
    const crew = (i: number | null) => (i === null ? null : tour.crews[i])
    const row = (t: Tie, side: 'home' | 'away') => {
      const idx = t[side]
      const c = crew(idx)
      const g = t.result ? t.result.goals[side === 'home' ? 0 : 1] : ''
      const so = t.result?.shootout ? ` <small>(${t.result.shootout[side === 'home' ? 0 : 1]})</small>` : ''
      const win = t.result && t.result.winner === idx
      return `<div class="row ${win ? 'win' : ''}"><span>${c ? `<span class="dot" style="background:${c.primary}"></span>${esc(c.name)}` : '<em>TBC</em>'}</span><span>${g}${so}</span></div>`
    }
    const next = tour.next
    const tie = (t: Tie, cls = '') => `<div class="tie ${cls} ${next === t ? 'next' : ''}"><small>${t.label}</small>${row(t, 'home')}${row(t, 'away')}</div>`
    const champ = tour.champion
    this.ui.html('[data-bracket]', `
      <div class="tape tape-b"></div>
      <h2>${champ !== null ? 'Champions!' : 'The bracket'}</h2>
      <p class="sub">${champ !== null ? `${esc(tour.crews[champ].name)} rule the streets.` : next ? `Up next: ${next.label}` : ''}</p>
      <div class="bracket">${tie(tour.ties[0])}${tie(tour.ties[1])}${tie(tour.ties[2], 'final')}</div>
      <div class="setup-actions">
        ${champ === null && next ? `<button class="btn" data-action="playtie">Play ${next.label}</button>` : '<button class="btn" data-action="mode:tournament">New tournament</button>'}
        <button class="chip" data-action="back">Menu</button>
      </div>`)
    this.ui.show('bracket')
  }

  // ---------------------------------------------------------------- match lifecycle
  startMatch(rules: Ruleset, surface: SurfaceId, opts: { live?: boolean; shootout?: boolean; teams?: [TeamDesign, TeamDesign]; vsAi?: boolean; online?: boolean } = {}): void {
    const live = opts.live ?? true
    this.endMatch()
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
    this.ui.setScore([0, 0])
    this.ui.html('[data-rules-body]', rulesHtml(rules, surface, !!opts.shootout))
    this.particles.clear()
    this.shake.clear()
    this.matchUnsubs.push(
      m.events.on('contact', c => this.onContact(c)),
      m.events.on('flick', f => {
        this.audio.flick(f.power)
        if (Math.abs(f.spin) > 0.6 && f.power > 0.45 && Math.random() < 0.5) this.say('curler', {}, 1)
        if (f.powerShot) { this.ui.banner('POWER SHOT!', '#ff7a1f', 900); this.say('powerShot', {}, 2); this.shake.add(4) }
        this.refreshMeters()
        this.refreshActionButton()
      }),
      m.events.on('turn', t => { if (!opts.online) this.onTurn(t.team, t.reason) }),
      m.events.on('goal', g => { if (!opts.online) this.onGoal(g.scorer, g.end, g.ownGoal, g.score.goals, g.capId) }),
      m.events.on('win', w => { if (!opts.online) this.onWin(w.team, w.score.goals, w.reason) }),
      m.events.on('phase', p => { if (p.phase !== 'aim') this.input.cancel(); this.refreshActionButton() }),
      m.events.on('whistle', w => this.onWhistle(w)),
      m.events.on('play', e => this.onPlayEvent(e)),
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
    for (const u of this.matchUnsubs) u()
    this.matchUnsubs = []
    this.input.cancel()
    this.aim = null
    this.replay = null
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
    if (clip.duration < 0.6 || !this.settings.replays) { m.finishGoal(); return }
    m.enterReplay()
    this.replay = { clip, t: 0 }
    this.ui.$('[data-replay]').hidden = false
    this.crowd.swell(0.5, 3)
  }

  /** Public skip (UI button, tap, tests). */
  skipReplay(): void { this.endReplay() }

  private endReplay(): void {
    if (!this.replay) return
    this.replay = null
    this.ui.$('[data-replay]').hidden = true
    this.match?.finishGoal()
  }

  private onTurn(team: TeamIndex, reason: TurnReason): void {
    const m = this.match
    this.ui.setTurn(team, this.teams, TURN_LABEL[reason])
    const color = this.teams[team].primary
    if (reason === 'bonus') { this.ui.banner('BONUS FLICK!', color, 1100); this.crowd.chant() }
    if (reason === 'corner' || reason === 'goalkick' || reason === 'freekick' || reason === 'penalty' || reason === 'offside' || reason === 'dropball') {
      this.ui.banner(TURN_LABEL[reason].toUpperCase(), color, 1100)
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
      this.ui.caption(`${this.teams[team].name}: drag your keeper along the line, then lock it. ${this.capName(m.takerId)} steps up.`, 3200)
    }
    this.refreshMeters()
    this.refreshActionButton()
    if (this.mode === 'ai' && team === 1 && this.live) this.scheduleAi(m)
    else this.cancelAi()
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
    this.crowd.ooh()
    this.ui.banner(w.kind === 'foul' ? 'FOUL!' : 'OFFSIDE!', '#f5d000', 1200)
    this.say(w.kind === 'foul' ? 'foul' : 'offside', {}, 3)
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
    const score = `${goals[0]} – ${goals[1]}${reason === 'shootout' ? ' on penalties' : ''}`
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
        if (this.tournament!.champion !== null) title = `${d[team].name} are champions!`
        actions = '<button class="btn" data-action="bracket">Continue</button>'
      }
    }
    this.ui.html('[data-win-actions]', actions)
    this.ui.showWinner(title, score, team === null ? '#888888' : d[team].primary)
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
    if (m.keeperSetting) {
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
    return !!m && this.mode === 'ai' && this.live && !!this.aiBrain && m.team === 1 && m.phase === 'aim' && !m.keeperSetting
  }

  private cancelAi(): void {
    this.aiEpoch++
    if (this.aiBusy || this.aiDecision || this.aiThinkMs > 0 || this.aiDragMs > 0) this.aim = null
    this.aiThinkMs = 0
    this.aiDragMs = 0
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

  // ---------------------------------------------------------------- input
  private pickable() {
    const m = this.match
    if (!m || !this.live || m.phase !== 'aim' || m.paused || this.ui.modalOpen || this.ui.root.dataset.current !== 'hud' || this.isAiTurn(m)) return []
    if (this.mode === 'online' && (!this.onlineState?.ready || this.onlineClient?.state !== 'open' || this.onlineTeam !== m.team)) return []
    return m.world.caps
      .map((b, id) => ({ b, id, info: m.world.capInfo(id) }))
      .filter(c => m.canPick(c.id))
      .map(c => ({ id: c.id, x: c.b.position.x, y: c.b.position.y, r: c.info.type.radius }))
  }

  private onAim(a: FlickAim | null): void {
    const m = this.match
    if (m?.keeperSetting) {
      // Shootout keeper: dragging slides it along the goal line instead of aiming.
      if (a) m.slideKeeper(a.pointer.y)
      this.aim = null
      return
    }
    this.aim = a
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
        if (this.mode === 'online') this.openOnline()
        else this.openSetup()
        break
      case 'ai-level':
        if (arg === 'easy' || arg === 'medium' || arg === 'hard') this.settings.aiLevel = arg as AiLevel
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'preset':
        this.settings.ruleset = arg
        this.settings.flags = {}
        saveSettings(this.settings)
        this.openSetup()
        break
      case 'surface':
        this.settings.surface = arg
        saveSettings(this.settings)
        this.renderer.setSurface(this.surface)
        this.match?.world.setSurface(this.surface)
        this.openSetup()
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
        if (arg === 'speech') { this.settings.speech = !this.settings.speech; this.voice.enabled = this.settings.speech; if (!this.settings.speech) this.voice.stop() }
        if (arg === 'tuning') this.setTuning(!this.settings.tuning)
        saveSettings(this.settings)
        this.renderStartMenu()
        break
      case 'tune': this.tune.toggle(); break
      case 'arm': this.match?.toggleArm(); this.refreshActionButton(); break
      case 'keeperready': this.match?.keeperReady(); break
      case 'skipreplay': this.endReplay(); break
      case 'online-copy': void this.copyOnlineInvite(); break
      case 'online-leave': this.toMenu(); break
      case 'playtie': this.playTie(); break
      case 'tie-shootout': this.tieShootout(); break
      case 'bracket': this.ui.modal(null); this.renderBracket(); break
      case 'restart':
        if (!this.match) return
        if (this.mode === 'online') { this.ui.caption('Leave this room to start a new match.', 2500); break }
        this.ui.modal(null)
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
      case 'newmatch': this.toMenu(); break
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
      case 'closemodal': this.ui.modal(null); break
      case 'sound':
        this.settings.sound = !this.settings.sound
        this.audio.setEnabled(this.settings.sound)
        if (this.settings.sound) this.crowd.start()
        else this.crowd.stop()
        this.ui.setSound(this.settings.sound)
        saveSettings(this.settings)
        break
    }
  }

  private setTuning(on: boolean): void {
    this.settings.tuning = on
    this.tune.setEnabled(on)
    this.ui.$('[data-tune-btn]').hidden = !on
  }

  private go(): void {
    const rules = buildRuleset(this.settings.ruleset, this.settings.flags)
    if (this.mode === 'quick') this.startMatch(rules, this.surface)
    else if (this.mode === 'ai') this.startMatch(rules, this.surface, { vsAi: true })
    else if (this.mode === 'shootout') this.startMatch(rules, this.surface, { shootout: true })
    else {
      this.tournament = new Tournament([this.settings.teams[0], this.settings.teams[1], ...RIVAL_CREWS])
      this.renderBracket()
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
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags), this.surface, { teams })
    this.ui.banner(tie.label.toUpperCase(), '#151515', 1300)
  }

  private tieShootout(): void {
    const tour = this.tournament
    const pend = this.pendingTie
    if (!tour || !pend || pend.tie.home === null || pend.tie.away === null) return
    this.currentTie = pend.tie
    const teams = resolveKits(tour.crews[pend.tie.home], tour.crews[pend.tie.away])
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags), this.surface, { shootout: true, teams })
  }

  private toMenu(): void {
    this.onlineClient?.stop()
    this.onlineState = null
    this.onlineTeam = null
    this.pendingOnlineActions.clear()
    this.ui.$('[data-local-restart]').hidden = false
    this.ui.$('[data-online-copy]').hidden = true
    this.ui.$('[data-online-leave]').hidden = true
    this.ui.modal(null)
    this.ui.html('[data-win-actions]', '<button class="btn" data-action="restart">Rematch</button><button class="btn ghost" data-action="newmatch">New match</button>')
    this.startMatch(buildRuleset(this.settings.ruleset, this.settings.flags), this.surface, { live: false })
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
    if (this.replay) {
      this.replay.t += s * FX.replaySpeed
      if (this.replay.t >= this.replay.clip.duration) this.endReplay()
    } else {
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
    const caps: CapView[] = m.world.caps.map((b, id) => {
      const info = m.world.capInfo(id)
      const p = rp ? rp.clip.pose(rp.t, id) : { x: b.position.x, y: b.position.y, angle: b.angle }
      return { x: p.x, y: p.y, angle: p.angle, team: info.team, slot: info.slot, type: info.type.id, active: m.world.isActive(b) }
    })
    const ball = rp ? rp.clip.pose(rp.t, m.world.caps.length) : { x: m.world.ball.position.x, y: m.world.ball.position.y, angle: m.world.ball.angle }
    return {
      caps,
      ball,
      aim: this.aim,
      pickTeam: this.live && m.phase === 'aim' && !m.paused ? m.team : null,
      pickable: this.live && m.phase === 'aim' ? (id: number) => !this.isAiTurn(m) && m.canPick(id) : undefined,
      powerShot: m.armed !== null && m.armed === m.team && m.phase === 'aim',
      activeCap: m.activeCap,
      replay: !!rp,
      time: t,
    }
  }

  /** Live handler counts — used by the smoke test to prove nothing stacks up across matches. */
  debugCounts(): Record<string, number> {
    return { input: activeInputHandlers(), matchListeners: this.match?.events.listenerCount() ?? 0, matchSubs: this.matchUnsubs.length, overlays: activeOverlays(), overlaySubs: this.tune.listenerCount }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.endMatch()
    this.crowd.stop()
    this.input.detach()
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
  if (r.corners) on.push(r.outBy === 'lastTouch'
    ? '<p><b>Corners &amp; goal kicks.</b> The ball smashing into the board beside a goal is out (soft rolls play on); the ref marks the spot. Real-football rule: the team that touched it <b>last</b> gives it up. Last touch by the defending team: corner to the attackers. Last touch by the attackers: goal kick.</p>'
    : '<p><b>Corners &amp; goal kicks.</b> The ball smashing into the board beside a goal is out (soft rolls play on); the ref marks the spot. Whoever\'s <b>flick</b> sent it out gives it up — deflections don\'t count. Your flick sends it into <b>their</b> end: goal kick to them, everyone back in formation. Your flick sends it into <b>your own</b> end: corner to them, both teams line up in the box.</p>')
  if (r.offside) on.push('<p><b>Offside.</b> A team-mate past the ball and the second-last defender (in the other half) when you flick is offside if the ball reaches them.</p>')
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
