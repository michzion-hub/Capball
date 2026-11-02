/** Named football-rule tuning. Physics values remain in tuning.ts; these values affect only decisions, restarts and local penalty phases. */
export const FOOTBALL = {
  /** Minimum collision impact for a cap-to-cap foul. */
  foulImpactMin: 0.4,
  /** Progress the fouled team must gain to retain advantage after the flick. */
  advantageGain: 60,
  /** Keep placement away from a drawn boundary line, in world units. */
  restartInset: 16,
  /** Distance from the penalty area edge for players who must retreat. */
  penaltyRetreatInset: 10,
  /** Penalty taker stands this far behind the ball, toward midfield. */
  penaltyTakerGap: 26,
  /** Keeper placement/drag inset from the goal line. */
  keeperLineInset: 3,
  /** Margin from the goal-area boundary when validating a keeper position. */
  keeperBoxInset: 4,
  /** Ball centre must be beyond the penalty-area edge by this many units to clear a goal kick. */
  goalKickClearance: 2,
  /** Keeper starts this far inside the goal line for a goal kick. */
  goalKickKeeperInset: 1,
  /** Clear space between the keeper cap and ball at a goal kick. */
  goalKickBallGap: 1,
  /** Each hidden keeper/shooter selection phase gets this much time. */
  hiddenPenaltyPhaseMs: 12_000,
  /** If the shooter times out with the straight-shot default, use this power. */
  timeoutStraightPower: 0.62,
  /** A conceded/forfeited penalty is an intentional, low-power miss away from goal. */
  forfeitPower: 0.16,
} as const

export type PenaltyTimeoutAction = 'straight' | 'forfeit'
