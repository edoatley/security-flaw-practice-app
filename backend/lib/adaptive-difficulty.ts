export type Tier = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

export interface AttemptRecord {
  correct: boolean;
  timeTakenMs: number;
  tierId: Tier;
  timestamp: string;
}

export interface SpeedMedians {
  BEGINNER: number;
  INTERMEDIATE: number;
  ADVANCED: number;
  sampleSizes: { BEGINNER: number; INTERMEDIATE: number; ADVANCED: number };
}

export interface AlgoParams {
  correctRateWeight: number;
  speedWeight: number;
  tierUpThreshold: number;
  tierDownThreshold: number;
  tierUpWindow: number;
  tierDownWindow: number;
}

export interface TierTransitionResult {
  newTier: Tier;
  changed: boolean;
}

export function computeCompositeScore(
  _attempts: AttemptRecord[],
  _medians: SpeedMedians,
  _params: AlgoParams
): number {
  return 0;
}

export function evaluateTierTransition(
  _currentTier: Tier,
  _window20: AttemptRecord[],
  _window10: AttemptRecord[],
  _composite20: number,
  _composite10: number,
  _params: AlgoParams
): TierTransitionResult {
  return { newTier: _currentTier, changed: false };
}
