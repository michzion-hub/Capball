/**
 * The commentator: a slightly unhinged pirate-radio voice from the wall of the car park.
 * Pure line selection (testable) + an optional SpeechSynthesis voice. Captions always show.
 */
export type CallKind =
  | 'kickoff' | 'goal' | 'ownGoal' | 'post' | 'foul' | 'offside' | 'corner' | 'goalkick' | 'penalty' | 'dropball' | 'curler'
  | 'bonus' | 'powerReady' | 'powerShot' | 'bigHit' | 'pass' | 'win' | 'draw' | 'halftime' | 'save' | 'miss'

export interface CallVars { team?: string; other?: string; cap?: string; score?: string }

const LINES: Record<CallKind, string[]> = {
  kickoff: ['And we are LIVE from the car park!', '{team} get us going. Mind the puddle.', 'Somebody move that shopping trolley — we\'re starting!'],
  goal: ['GOAL! {cap} buries it for {team}!', 'Get in! {cap}! Absolute scenes by the bins!', 'That is FILTHY from {cap}! {score}!', '{team} score! Someone tell the neighbours!'],
  ownGoal: ['Oh no. OH NO. Own goal, and {other} will take it.', 'Into his own net! {cap} will be buying the chips tonight.'],
  post: ['Off the post! Ding! You could hear that in the next street!', 'POST! So close my nan dropped her tea.', 'Clang! The woodwork says no.'],
  foul: ['Foul! That cap went in like a shopping trolley down a hill.', 'Whistle! No ball, all elbow.', 'That\'s a booking in any league with a referee.'],
  offside: ['Offside! He was practically in the next postcode.', 'Flag\'s up! Lurking, that\'s what that was.'],
  corner: ['{other} put it behind their own goal. Corner to {team}!', '{other} hoof it into their own end boards — corner to {team}. Pack the box!'],
  goalkick: ['{other} smash it into the end boards. Goal kick to {team}.', 'Wild from {other}! Over the end line — goal kick to {team}.'],
  dropball: ['That ball is going nowhere. Ref, do the honours.', 'Stuck in the corner like a lost glove. Dropped ball!', 'Ref picks it out of the gutter and drops it. Play on!'],
  curler: ['Ooh, he\'s bent that one round the bins!', 'Curling, curling… what a banana!', 'Spin on it! That cap has been to finishing school.'],
  penalty: ['PENALTY! In the box and he\'s clattered him!', 'Spot kick! Nerves of steel needed now.'],
  bonus: ['Off the boards and back to {cap}! The wall is on {team}\'s side!', 'The boards play a one-two! Bonus flick!', 'Concrete assist! Go again!'],
  powerReady: ['{team} are stringing it together — power shot loaded!', 'Lovely passing. Somebody\'s about to get hurt.'],
  powerShot: ['He\'s wound it up — POWER SHOT!', 'Here comes the thunderbolt!'],
  bigHit: ['WHACK! That\'s a dent.', 'Ooh, that one rattled the fillings.', 'Big hit! Caps everywhere!'],
  pass: ['Nice little pass.', 'Tiki-taka, car-park style.'],
  win: ['That\'s it! {team} win it {score}! Drinks are on the losers!', 'Full time! {team} are the kings of the concrete!'],
  draw: ['All square. Everybody\'s a winner. Except the grass.'],
  halftime: ['Half time. Orange slices round the back.'],
  save: ['SAVED! That keeper\'s got glue on the bottom!', 'What a stop! Sticky fingers!'],
  miss: ['Wide! That\'s gone in the hedge.', 'Off target. Someone fetch it from the road.'],
}

export class Commentator {
  private last = new Map<CallKind, number>()
  private lastAt = -1e9
  private queued: string | null = null

  constructor(private readonly rng: () => number = Math.random) {}

  /** Pick a line; never the same line twice in a row for a kind. */
  line(kind: CallKind, vars: CallVars = {}): string {
    const pool = LINES[kind]
    let i = Math.floor(this.rng() * pool.length)
    if (pool.length > 1 && i === this.last.get(kind)) i = (i + 1) % pool.length
    this.last.set(kind, i)
    return pool[i].replace(/\{(\w+)\}/g, (_, k: keyof CallVars) => vars[k] ?? '')
  }

  /**
   * Rate-limited: low-priority calls are dropped if something was said very recently.
   * Returns the line to show, or null if suppressed.
   */
  call(kind: CallKind, vars: CallVars, now: number, priority = 1): string | null {
    const gap = priority >= 3 ? 0 : priority === 2 ? 900 : 2600
    if (now - this.lastAt < gap) return null
    this.lastAt = now
    this.queued = this.line(kind, vars)
    return this.queued
  }
}

/** Optional voice. Uses the platform speech engine when available; silent otherwise. */
export class Voice {
  enabled = false
  private readonly synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  get available(): boolean { return this.synth !== null }
  say(text: string, urgent = false): void {
    if (!this.enabled || !this.synth) return
    if (urgent) this.synth.cancel()
    else if (this.synth.speaking) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.12
    u.pitch = 0.95
    u.volume = 0.9
    const en = this.synth.getVoices().find(v => /en[-_]GB/i.test(v.lang)) ?? this.synth.getVoices().find(v => v.lang.startsWith('en'))
    if (en) u.voice = en
    this.synth.speak(u)
  }
  stop(): void { this.synth?.cancel() }
}
