export type Tier = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

export interface AttemptRecord {
  correct: boolean;
  timeTakenMs: number;
  tierId: Tier;
  timestamp: string;
}

export interface SpeedMedians {
  BEGINNER: number | null;
  INTERMEDIATE: number | null;
  ADVANCED: number | null;
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

export const DEFAULT_ALGO_PARAMS: AlgoParams = {
  correctRateWeight: 0.7,
  speedWeight: 0.3,
  tierUpThreshold: 0.75,
  tierDownThreshold: 0.4,
  tierUpWindow: 20,
  tierDownWindow: 10,
};

const MEDIAN_MIN_SAMPLE_SIZE = 100;

function speedScoreForAttempt(attempt: AttemptRecord, medians: SpeedMedians): number {
  const sampleSize = medians.sampleSizes[attempt.tierId] ?? 0;
  const median = medians[attempt.tierId];

  if (sampleSize < MEDIAN_MIN_SAMPLE_SIZE || median === null || median <= 0) {
    return 0.5;
  }

  const rawSpeed = median / attempt.timeTakenMs;
  return Math.min(2, Math.max(0, rawSpeed)) / 2;
}

export function computeCompositeScore(
  attempts: AttemptRecord[],
  medians: SpeedMedians,
  params: AlgoParams
): number {
  if (attempts.length === 0) return 0;

  const correctCount = attempts.filter((a) => a.correct).length;
  const correctRate = correctCount / attempts.length;

  const totalSpeedScore = attempts.reduce(
    (sum, a) => sum + speedScoreForAttempt(a, medians),
    0
  );
  const windowSpeedScore = totalSpeedScore / attempts.length;

  return params.correctRateWeight * correctRate + params.speedWeight * windowSpeedScore;
}

const TIER_ORDER: Tier[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED"];

export function evaluateTierTransition(
  currentTier: Tier,
  window20: AttemptRecord[],
  window10: AttemptRecord[],
  composite20: number,
  composite10: number,
  params: AlgoParams
): TierTransitionResult {
  const tierIndex = TIER_ORDER.indexOf(currentTier);

  // Check tier-up first
  if (
    window20.length === params.tierUpWindow &&
    composite20 >= params.tierUpThreshold &&
    tierIndex < TIER_ORDER.length - 1
  ) {
    return { newTier: TIER_ORDER[tierIndex + 1], changed: true };
  }

  // Check tier-down only if tier-up was not triggered
  if (
    window10.length === params.tierDownWindow &&
    composite10 < params.tierDownThreshold &&
    tierIndex > 0
  ) {
    return { newTier: TIER_ORDER[tierIndex - 1], changed: true };
  }

  return { newTier: currentTier, changed: false };
}
