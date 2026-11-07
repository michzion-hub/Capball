export type RuleHintKey = 'goalKick' | 'corner' | 'foul' | 'offside' | 'penalty' | 'shootout'

export interface RuleHintContent {
  key: RuleHintKey
  label: string
  why: string
  restart: string
  restriction: string
}

export function makeRuleHint(
  key: RuleHintKey,
  team: string,
  other: string,
  why: string,
  restriction: string,
): RuleHintContent {
  const label: Record<RuleHintKey, string> = {
    goalKick: 'Goal kick',
    corner: 'Corner',
    foul: 'Free kick',
    offside: 'Offside',
    penalty: 'Penalty',
    shootout: 'Penalty shootout',
  }
  const restart: Record<RuleHintKey, string> = {
    goalKick: `${team} restart with the ball in front of their keeper.`,
    corner: `${team} take the restart from the nearest corner.`,
    foul: `${team} take the free kick where the contact happened.`,
    offside: `${team} take an indirect free kick from the offside spot.`,
    penalty: `${team} get one flick from the penalty spot.`,
    shootout: `${team} take the next kick in the penalty shootout.`,
  }
  return { key, label: label[key], why: why || `${other} gave away the restart.`, restart: restart[key], restriction }
}
