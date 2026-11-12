import { describe, expect, it } from 'vitest'
import { INVITE_PROFILE, ONLINE_PROFILES, RULESETS, getOnlineProfile, profileInfo } from '../src/config/rulesets'

describe('online invite rules profile', () => {
  it('pins the Proper Football invite rules exactly', () => {
    const rules = INVITE_PROFILE.ruleset
    expect(INVITE_PROFILE.id).toBe('proper-invite')
    expect(INVITE_PROFILE.version).toBe(1)
    expect(INVITE_PROFILE.name).toBe('Proper Football · Invite')
    expect(rules.halves).toEqual({ count: 2, seconds: 180 })
    expect(rules.outBy).toBe('lastTouch')
    expect(rules.hiddenPenalties).toBe(true)
    expect(rules.keeperMayLeaveLine).toBe(false)
    expect(rules.penaltyTimeout).toBe('straight')
    expect(rules.goalsToWin).toBeNull()
    expect(rules.corners).toBe(true)
    expect(rules.freeKicks).toBe(true)
    expect(rules.penalties).toBe(true)
    expect(rules.offside).toBe(true)
  })

  it('only resolves allowlisted id and version pairs', () => {
    expect(getOnlineProfile('proper-invite', 1)).toBe(INVITE_PROFILE)
    expect(getOnlineProfile('proper-invite', 2)).toBeNull()
    expect(getOnlineProfile('street', 1)).toBeNull()
    expect(getOnlineProfile(undefined, 1)).toBeNull()
    expect(getOnlineProfile('proper-invite', '1')).toBeNull()
    expect(profileInfo(INVITE_PROFILE)).toEqual({ id: 'proper-invite', version: 1, name: 'Proper Football · Invite' })
    expect(ONLINE_PROFILES).toContain(INVITE_PROFILE)
  })

  it('keeps the shared profile independent from the editable local preset', () => {
    expect(INVITE_PROFILE.ruleset).not.toBe(RULESETS.proper)
    expect(RULESETS.proper.hiddenPenalties).toBe(false)
    expect(RULESETS.proper.keeperMayLeaveLine).toBe(false)
  })
})
