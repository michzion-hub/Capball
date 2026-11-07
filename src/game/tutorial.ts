import type { TrackerEvent } from './play'
import type { TeamIndex } from '../physics/world'

export const TUTORIAL_STEPS = [
  {
    id: 'flick',
    title: 'Meet the flick',
    copy: 'Drag back from one of your caps, then release. Pull opposite to the direction you want the cap to move.',
    hint: 'Start with a short, straight drag; the cap moves through real collisions, not a preset distance.',
  },
  {
    id: 'aim',
    title: 'Aim and power',
    copy: 'Use the arrow to aim toward the far goal. Try a short pull, then a longer one to feel the power meter respond.',
    hint: 'A tiny pull cancels; the power meter fills as you drag farther and tops out at the power cap.',
  },
  {
    id: 'settle',
    title: 'Let the play settle',
    copy: 'Take one more flick. Your next turn unlocks only when the ball and every cap have stopped moving.',
    hint: 'Nothing is stuck—the game is waiting for the whole play to come to rest.',
  },
  {
    id: 'boards',
    title: 'Use the boards',
    copy: 'First, flick the ball into the far end board and watch the real rebound. Boards stay in play.',
    hint: 'Aim toward a side rail. A shallow angle is easier to control than a hard straight hit.',
  },
  {
    id: 'passes',
    title: 'Build a pass chain',
    copy: 'Send the ball into a different friendly cap. Three real completed passes charge a power shot; the combo meter appears here.',
    hint: 'Use a gentle flick toward the next friendly cap. The chain breaks if the other team touches the ball.',
  },
  {
    id: 'power',
    title: 'Take the power shot',
    copy: 'Your pass chain is charged. Tap USE POWER SHOT, then take a real flick with one of your caps.',
    hint: 'The power shot stays ready until you arm it. Tap the yellow button before aiming.',
  },
  {
    id: 'caps',
    title: 'Optional: choose your cap',
    copy: 'Try the highlighted cap, then compare another type. Wingers, defenders, keepers and strikers have different weight and glide.',
    hint: 'The winger is light and slippery; the striker hits hard. A short practice flick makes the difference easier to feel.',
  },
] as const

export type TutorialStepId = typeof TUTORIAL_STEPS[number]['id']
export const TUTORIAL_COMPLETE_STEP = TUTORIAL_STEPS.length

export interface TutorialSnapshot {
  step: number
  boardPhase: 'rebound' | 'bonus'
  sawBoard: boolean
  passes: number
  capTypes: string[]
  attempts: number
  shortPullSeen: boolean
  longPullSeen: boolean
  hintVisible: boolean
  complete: boolean
}

/**
 * Tutorial progression is driven only by real Match/PlayTracker events. Drill setup and
 * retries are separate App operations and must be called only after the world settles.
 */
export class TutorialProgress {
  private current: number
  private boardPhaseValue: 'rebound' | 'bonus' = 'rebound'
  private sawBoardValue = false
  private passCount = 0
  private capTypeSet = new Set<string>()
  private attemptCount = 0
  private shortPullSeen = false
  private longPullSeen = false
  private hintShown = false
  private settleFlickSeen = false

  constructor(savedStep = 0) {
    this.current = Number.isFinite(savedStep)
      ? Math.max(0, Math.min(TUTORIAL_COMPLETE_STEP, Math.floor(savedStep)))
      : 0
  }

  get step(): number { return this.current }
  get complete(): boolean { return this.current >= TUTORIAL_COMPLETE_STEP }
  get stepId(): TutorialStepId | null { return this.complete ? null : TUTORIAL_STEPS[this.current].id }

  onFlick(team: TeamIndex, powerShot: boolean, capType: string, power = 0): boolean {
    if (team !== 0 || this.complete) return false
    if (this.current === 0) return this.advance()
    if (this.current === 1) {
      this.attemptCount += 1
      if (power < 0.4) this.shortPullSeen = true
      else this.longPullSeen = true
      if (this.shortPullSeen && this.longPullSeen) return this.advance()
      return false
    }
    if (this.current === 2) {
      this.attemptCount += 1
      this.settleFlickSeen = true
      return false
    }
    if (this.current === 3 || this.current === 4 || this.current === 5 || this.current === 6) this.attemptCount += 1
    if (this.current === 5 && powerShot) return this.advance()
    if (this.current === 6) {
      this.capTypeSet.add(capType)
      if (this.capTypeSet.size >= 2) return this.advance()
    }
    return false
  }

  onPlay(event: TrackerEvent): boolean {
    if (this.complete) return false
    if (this.current === 3) {
      if (event.type === 'boardHit' && this.boardPhaseValue === 'rebound') {
        this.sawBoardValue = true
        return true
      }
      if (event.type === 'boardBonus' && event.team === 0 && this.boardPhaseValue === 'bonus') return this.advance()
      return false
    }
    if (this.current === 4) {
      if (event.type === 'pass' && event.team === 0) {
        this.passCount = Math.min(3, this.passCount + 1)
        return true
      }
      if (event.type === 'powerReady' && event.team === 0) return this.advance()
    }
    return false
  }

  onSettled(): boolean {
    if (this.current === 2 && this.settleFlickSeen) {
      this.settleFlickSeen = false
      return this.advance()
    }
    if (this.current === 3 && this.sawBoardValue) {
      this.sawBoardValue = false
      this.boardPhaseValue = 'bonus'
      this.attemptCount = 0
      this.hintShown = false
      return true
    }
    return false
  }

  skip(): boolean { return this.complete ? false : this.advance() }

  retry(): void {
    if (this.complete) return
    this.attemptCount = 0
    this.hintShown = false
    this.shortPullSeen = false
    this.longPullSeen = false
    this.settleFlickSeen = false
    if (this.current === 3) { this.boardPhaseValue = 'rebound'; this.sawBoardValue = false }
    if (this.current === 4) this.passCount = 0
    if (this.current === 6) this.capTypeSet.clear()
  }

  revealHint(): void { this.hintShown = true }

  snapshot(): TutorialSnapshot {
    return {
      step: this.current,
      boardPhase: this.boardPhaseValue,
      sawBoard: this.sawBoardValue,
      passes: this.passCount,
      capTypes: [...this.capTypeSet],
      attempts: this.attemptCount,
      shortPullSeen: this.shortPullSeen,
      longPullSeen: this.longPullSeen,
      hintVisible: this.hintShown,
      complete: this.complete,
    }
  }

  private advance(): boolean {
    this.current = Math.min(TUTORIAL_COMPLETE_STEP, this.current + 1)
    this.boardPhaseValue = 'rebound'
    this.sawBoardValue = false
    this.passCount = 0
    this.capTypeSet.clear()
    this.attemptCount = 0
    this.shortPullSeen = false
    this.longPullSeen = false
    this.settleFlickSeen = false
    this.hintShown = false
    return true
  }
}
