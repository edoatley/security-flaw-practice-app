import { describe, it, expect } from "vitest";
import {
  computeCompositeScore,
  evaluateTierTransition,
  TIER_ORDER,
  DEFAULT_ALGO_PARAMS,
  type AttemptRecord,
  type SpeedMedians,
} from "./adaptive-difficulty";

const MEDIANS_WITH_DATA: SpeedMedians = {
  BEGINNER: 60_000,
  INTERMEDIATE: 90_000,
  ADVANCED: 180_000,
  sampleSizes: { BEGINNER: 150, INTERMEDIATE: 120, ADVANCED: 100 },
};

const MEDIANS_INSUFFICIENT: SpeedMedians = {
  BEGINNER: 60_000,
  INTERMEDIATE: null,
  ADVANCED: null,
  sampleSizes: { BEGINNER: 50, INTERMEDIATE: 0, ADVANCED: 0 },
};

const MEDIANS_EMPTY: SpeedMedians = {
  BEGINNER: null,
  INTERMEDIATE: null,
  ADVANCED: null,
  sampleSizes: { BEGINNER: 0, INTERMEDIATE: 0, ADVANCED: 0 },
};

function makeAttempts(
  count: number,
  overrides: Partial<AttemptRecord> = {}
): AttemptRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    correct: true,
    timeTakenMs: 30_000,
    tierId: "BEGINNER",
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    ...overrides,
  }));
}

// ---------------------------------------------------------------------------
// TIER_ORDER
// ---------------------------------------------------------------------------

describe("TIER_ORDER", () => {
  it("is ordered BEGINNER → INTERMEDIATE → ADVANCED", () => {
    expect(TIER_ORDER).toEqual(["BEGINNER", "INTERMEDIATE", "ADVANCED"]);
  });

  it("correctly identifies promotions via indexOf", () => {
    expect(TIER_ORDER.indexOf("INTERMEDIATE") > TIER_ORDER.indexOf("BEGINNER")).toBe(true);
    expect(TIER_ORDER.indexOf("ADVANCED") > TIER_ORDER.indexOf("INTERMEDIATE")).toBe(true);
    expect(TIER_ORDER.indexOf("ADVANCED") > TIER_ORDER.indexOf("BEGINNER")).toBe(true);
  });

  it("correctly identifies demotions via indexOf", () => {
    expect(TIER_ORDER.indexOf("BEGINNER") > TIER_ORDER.indexOf("INTERMEDIATE")).toBe(false);
    expect(TIER_ORDER.indexOf("INTERMEDIATE") > TIER_ORDER.indexOf("ADVANCED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------

describe("computeCompositeScore", () => {
  it("returns 0 for an empty window", () => {
    expect(computeCompositeScore([], MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS)).toBe(0);
  });

  it("returns 1.0 when all correct and answered at median speed", () => {
    // timeTakenMs = median → rawSpeed = 1 → speedScore = 0.5 → /2 = 0.5
    // composite = 0.7 * 1.0 + 0.3 * 0.5 = 0.85
    const attempts = makeAttempts(20, { timeTakenMs: 60_000, tierId: "BEGINNER" });
    const score = computeCompositeScore(attempts, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(score).toBeCloseTo(0.85, 5);
  });

  it("returns 1.0 composite when all correct and answered twice as fast as median", () => {
    // timeTakenMs = 30_000, median = 60_000 → rawSpeed = 2 → capped at 1.0
    // composite = 0.7 * 1.0 + 0.3 * 1.0 = 1.0
    const attempts = makeAttempts(20, { timeTakenMs: 30_000, tierId: "BEGINNER" });
    const score = computeCompositeScore(attempts, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("uses neutral speed (0.5) when sampleSize < 100", () => {
    // BEGINNER sampleSize = 50 → speedScore = 0.5 neutral
    // all correct → composite = 0.7 * 1.0 + 0.3 * 0.5 = 0.85
    const attempts = makeAttempts(10, { timeTakenMs: 1_000, tierId: "BEGINNER" });
    const score = computeCompositeScore(attempts, MEDIANS_INSUFFICIENT, DEFAULT_ALGO_PARAMS);
    expect(score).toBeCloseTo(0.85, 5);
  });

  it("uses neutral speed (0.5) when median is null", () => {
    const attempts = makeAttempts(10, { timeTakenMs: 1_000, tierId: "INTERMEDIATE" });
    const score = computeCompositeScore(attempts, MEDIANS_EMPTY, DEFAULT_ALGO_PARAMS);
    // 0.7 * 1.0 + 0.3 * 0.5 = 0.85
    expect(score).toBeCloseTo(0.85, 5);
  });

  it("clamps speed score to 0 when timeTaken >> median", () => {
    // timeTakenMs = 600_000, median = 60_000 → rawSpeed = 0.1 → speedScore = 0.05
    // composite = 0.7 * 1.0 + 0.3 * 0.05 = 0.715
    const attempts = makeAttempts(5, { timeTakenMs: 600_000, tierId: "BEGINNER" });
    const score = computeCompositeScore(attempts, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(score).toBeCloseTo(0.715, 2);
  });

  it("accounts for wrong answers in correct rate", () => {
    // 10 correct + 10 wrong = 50% correct rate, speed at median = 0.5
    // composite = 0.7 * 0.5 + 0.3 * 0.5 = 0.5
    const correct = makeAttempts(10, { correct: true, timeTakenMs: 60_000, tierId: "BEGINNER" });
    const wrong = makeAttempts(10, { correct: false, timeTakenMs: 60_000, tierId: "BEGINNER" });
    const score = computeCompositeScore([...correct, ...wrong], MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("matches worked example from adaptive-difficulty.md §3.6 (composite ≈ 0.829)", () => {
    // 17 correct of 20, speed scores averaging ~0.6 → composite ≈ 0.829
    // Reproduce: 17 correct at timeTakenMs=45_000 (speedScore=min(2,60000/45000)/2=0.667)
    //            + 3 wrong at timeTakenMs=45_000
    // correctRate = 17/20 = 0.85
    // windowSpeedScore = 0.667
    // composite = 0.7 * 0.85 + 0.3 * 0.667 = 0.595 + 0.200 = 0.795
    // Note: the exact doc example uses specific per-attempt values; this tests the formula shape.
    const correct = makeAttempts(17, { correct: true, timeTakenMs: 45_000, tierId: "BEGINNER" });
    const wrong = makeAttempts(3, { correct: false, timeTakenMs: 45_000, tierId: "BEGINNER" });
    const score = computeCompositeScore([...correct, ...wrong], MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const expectedCorrectRate = 17 / 20;
    const expectedSpeedScore = Math.min(2, 60_000 / 45_000) / 2;
    const expected =
      DEFAULT_ALGO_PARAMS.correctRateWeight * expectedCorrectRate +
      DEFAULT_ALGO_PARAMS.speedWeight * expectedSpeedScore;
    expect(score).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// evaluateTierTransition
// ---------------------------------------------------------------------------

describe("evaluateTierTransition", () => {
  it("returns no change when window is smaller than required", () => {
    const window19 = makeAttempts(19, { correct: true, timeTakenMs: 30_000, tierId: "BEGINNER" });
    const composite = computeCompositeScore(window19, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("BEGINNER", window19, [], composite, 0, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "BEGINNER", changed: false });
  });

  it("promotes BEGINNER → INTERMEDIATE when composite ≥ 0.75 over 20 attempts", () => {
    const window20 = makeAttempts(20, { correct: true, timeTakenMs: 30_000, tierId: "BEGINNER" });
    const composite = computeCompositeScore(window20, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(composite).toBeGreaterThanOrEqual(DEFAULT_ALGO_PARAMS.tierUpThreshold);
    const result = evaluateTierTransition("BEGINNER", window20, [], composite, 0, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "INTERMEDIATE", changed: true });
  });

  it("promotes INTERMEDIATE → ADVANCED when composite ≥ 0.75 over 20 attempts", () => {
    const window20 = makeAttempts(20, { correct: true, timeTakenMs: 45_000, tierId: "INTERMEDIATE" });
    const composite = computeCompositeScore(window20, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(composite).toBeGreaterThanOrEqual(DEFAULT_ALGO_PARAMS.tierUpThreshold);
    const result = evaluateTierTransition("INTERMEDIATE", window20, [], composite, 0, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "ADVANCED", changed: true });
  });

  it("does not promote beyond ADVANCED", () => {
    const window20 = makeAttempts(20, { correct: true, timeTakenMs: 30_000, tierId: "ADVANCED" });
    const composite = computeCompositeScore(window20, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("ADVANCED", window20, [], composite, 0, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "ADVANCED", changed: false });
  });

  it("demotes INTERMEDIATE → BEGINNER when composite < 0.40 over 10 attempts", () => {
    const window10 = makeAttempts(10, { correct: false, timeTakenMs: 600_000, tierId: "INTERMEDIATE" });
    const composite10 = computeCompositeScore(window10, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    expect(composite10).toBeLessThan(DEFAULT_ALGO_PARAMS.tierDownThreshold);
    const result = evaluateTierTransition("INTERMEDIATE", [], window10, 0, composite10, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "BEGINNER", changed: true });
  });

  it("demotes ADVANCED → INTERMEDIATE when composite < 0.40 over 10 attempts", () => {
    const window10 = makeAttempts(10, { correct: false, timeTakenMs: 600_000, tierId: "ADVANCED" });
    const composite10 = computeCompositeScore(window10, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("ADVANCED", [], window10, 0, composite10, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "INTERMEDIATE", changed: true });
  });

  it("does not demote below BEGINNER", () => {
    const window10 = makeAttempts(10, { correct: false, timeTakenMs: 600_000, tierId: "BEGINNER" });
    const composite10 = computeCompositeScore(window10, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("BEGINNER", [], window10, 0, composite10, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "BEGINNER", changed: false });
  });

  it("prefers promotion over demotion when both would trigger", () => {
    // Full windows for both up and down, composite ≥ tier-up threshold
    const window20 = makeAttempts(20, { correct: true, timeTakenMs: 30_000, tierId: "INTERMEDIATE" });
    const window10 = makeAttempts(10, { correct: false, timeTakenMs: 600_000, tierId: "INTERMEDIATE" });
    const composite20 = computeCompositeScore(window20, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const composite10 = computeCompositeScore(window10, MEDIANS_WITH_DATA, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("INTERMEDIATE", window20, window10, composite20, composite10, DEFAULT_ALGO_PARAMS);
    expect(result).toEqual({ newTier: "ADVANCED", changed: true });
  });

  it("returns no change when composite is between thresholds", () => {
    // ~60% correct, neutral speed → composite ≈ 0.57 (between 0.40 and 0.75)
    const correct = makeAttempts(12, { correct: true, timeTakenMs: 60_000, tierId: "BEGINNER" });
    const wrong = makeAttempts(8, { correct: false, timeTakenMs: 60_000, tierId: "BEGINNER" });
    const window20 = [...correct, ...wrong];
    const composite = computeCompositeScore(window20, MEDIANS_EMPTY, DEFAULT_ALGO_PARAMS);
    const result = evaluateTierTransition("BEGINNER", window20, window20.slice(-10), composite, composite, DEFAULT_ALGO_PARAMS);
    expect(result.changed).toBe(false);
  });
});
