# EARS Specifications: Adaptive Difficulty System

**Component:** Adaptive Difficulty Algorithm  
**Version:** 0.1 (Draft)  
**Date:** 2026-05-16  
**Author:** edoatley@gmail.com  
**Source LLDs:** `llds/adaptive-difficulty.md` v0.1, `llds/api.md` v0.1

---

## Status Key

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Active — not yet implemented |
| `[x]`  | Implemented |
| `[D]`  | Deferred — out of scope for current iteration |

---

## 1. Initial User State

**DIFF-001** `[ ]`  
When a new user profile is created, the adaptive difficulty system shall assign the user a current tier of BEGINNER.

> Source: adaptive-difficulty.md §6.1 — "New users are written to the Users table … with `currentTier = BEGINNER`"; api.md §3.4 Step 1 — lazy profile creation sets `currentTier=BEGINNER`.

---

## 2. Rolling Window Sizes

**DIFF-002** `[ ]`  
The adaptive difficulty system shall use a rolling window of the 20 most recent attempts at the user's current tier when evaluating whether to promote the user to a higher tier.

> Source: adaptive-difficulty.md §2.2 — "N = 20 for tier-up evaluation".

**DIFF-003** `[ ]`  
The adaptive difficulty system shall use a rolling window of the 10 most recent attempts at the user's current tier when evaluating whether to demote the user to a lower tier.

> Source: adaptive-difficulty.md §2.2 — "N = 10 for tier-down evaluation".

**DIFF-004** `[ ]`  
While a user has fewer attempts at the current tier than the applicable window size, the adaptive difficulty system shall use all available current-tier attempts as the scoring window rather than requiring the window to be full before computing a score.

> Source: adaptive-difficulty.md §6.1 — "When a user has fewer than 20 total attempts, the window is simply all available attempts."

---

## 3. Composite Score Formula

**DIFF-005** `[ ]`  
The adaptive difficulty system shall compute the composite score for a scoring window using the formula:

```
compositeScore = 0.70 × correctRate + 0.30 × windowSpeedScore
```

where `correctRate` is the proportion of correct attempts in the window and `windowSpeedScore` is the mean of per-attempt speed scores across the window.

> Source: adaptive-difficulty.md §3.5.

**DIFF-006** `[ ]`  
The adaptive difficulty system shall compute the correct rate for a window as the count of correct attempts divided by the total number of attempts in the window, yielding a value in the range [0, 1].

> Source: adaptive-difficulty.md §3.2.

**DIFF-007** `[ ]`  
The adaptive difficulty system shall compute the per-attempt speed score by dividing the per-difficulty median response time by the attempt's `timeTakenMs`, clamping the result to the range [0, 2], and then dividing by 2 to normalise to [0, 1]:

```
rawSpeed(i)   = M(dᵢ) / timeTakenMs(i)
speedScore(i) = clamp(rawSpeed(i), 0, 2) / 2
```

> Source: adaptive-difficulty.md §3.3.

**DIFF-008** `[ ]`  
The adaptive difficulty system shall compute the window speed score as the arithmetic mean of all per-attempt speed scores within the scoring window.

> Source: adaptive-difficulty.md §3.4.

---

## 4. Speed Score Normalisation

**DIFF-009** `[ ]`  
The adaptive difficulty system shall normalise each attempt's speed score against the median `timeTakenMs` recorded for the difficulty tier (`tierId`) that was active at the time of that attempt, not the user's current tier at evaluation time.

> Source: adaptive-difficulty.md §3.1 — M(dᵢ) uses the tierId of attempt i; §9.6 — per-attempt scoring handles windows that span tier transitions.

**DIFF-010** `[ ]`  
The adaptive difficulty system shall store per-difficulty median response times in DynamoDB under the key `PK = CONFIG`, `SK = SPEED_MEDIANS`, with separate median values for BEGINNER, INTERMEDIATE, and ADVANCED tiers.

> Source: adaptive-difficulty.md §5.3.

---

## 5. Bootstrap / Cold-Start Behaviour

**DIFF-011** `[ ]`  
If the sample size for a difficulty tier recorded in the `SPEED_MEDIANS` config item is fewer than 100, the adaptive difficulty system shall substitute a speed score of 0.5 for every attempt at that tier instead of computing a normalised speed score.

> Source: adaptive-difficulty.md §5.4 — "A median is considered established when `sampleSize ≥ 100` … defaults to `0.5` (neutral)."

**DIFF-012** `[ ]`  
The adaptive difficulty system shall treat the neutral speed score default of 0.5 as applying per-tier independently, so that an established median for one tier does not affect whether the neutral default is used for another tier.

> Source: adaptive-difficulty.md §5.4 — cold-start ladder describes per-tier establishment.

---

## 6. Tier-Up Condition

**DIFF-013** `[ ]`  
When the scoring window for the user's current tier contains exactly 20 attempts and the composite score computed over those 20 attempts is greater than or equal to 0.75, the adaptive difficulty system shall promote the user to the next higher tier.

> Source: adaptive-difficulty.md §4.2, §4.5 Step 4a.

**DIFF-014** `[ ]`  
The adaptive difficulty system shall not promote a user from BEGINNER directly to ADVANCED; promotion shall always advance the user one tier at a time (BEGINNER → INTERMEDIATE → ADVANCED).

> Source: adaptive-difficulty.md §4.3.

**DIFF-015** `[ ]`  
The adaptive difficulty system shall not promote a user who is already at the ADVANCED tier.

> Source: adaptive-difficulty.md §4.1 — ADVANCED is the terminal tier for promotion.

---

## 7. Tier-Down Condition

**DIFF-016** `[ ]`  
When the scoring window for the user's current tier contains exactly 10 attempts and the composite score computed over those 10 attempts is strictly less than 0.40, the adaptive difficulty system shall demote the user to the next lower tier.

> Source: adaptive-difficulty.md §4.2, §4.5 Step 5c.

**DIFF-017** `[ ]`  
The adaptive difficulty system shall not demote a user from ADVANCED directly to BEGINNER; demotion shall always move the user one tier at a time (ADVANCED → INTERMEDIATE → BEGINNER).

> Source: adaptive-difficulty.md §4.3.

**DIFF-018** `[ ]`  
The adaptive difficulty system shall not demote a user who is at the BEGINNER tier.

> Source: adaptive-difficulty.md §4.1 — BEGINNER is the terminal tier for demotion.

**DIFF-019** `[ ]`  
While the user's composite score for a window falls in the range [0.40, 0.75), the adaptive difficulty system shall trigger no tier transition, regardless of how many consecutive attempts produce a score in that range.

> Source: adaptive-difficulty.md §4.6 — hysteresis band.

---

## 8. Tier Evaluation Trigger

**DIFF-020** `[ ]`  
When the SubmitAnswer Lambda successfully records a new attempt, the adaptive difficulty system shall re-evaluate the user's tier immediately within the same Lambda invocation before returning the HTTP response.

> Source: adaptive-difficulty.md §1 — "runs entirely within the `SubmitAnswer` Lambda function on every call"; §4.5 — evaluation order.

**DIFF-021** `[ ]`  
The adaptive difficulty system shall evaluate the tier-up condition before the tier-down condition within a single SubmitAnswer invocation, and shall not evaluate the tier-down condition if a tier-up transition has already been triggered in that invocation.

> Source: adaptive-difficulty.md §4.5 Step 4–5 — "Evaluate tier-down condition (only if tier-up was NOT triggered)".

**DIFF-022** `[ ]`  
The adaptive difficulty system shall perform no tier evaluation in the GetProgress Lambda; GetProgress shall read the current tier value persisted to the Users record by the most recent SubmitAnswer invocation.

> Source: adaptive-difficulty.md §7.2.

---

## 9. Algorithm Parameters and Configuration

**DIFF-023** `[ ]`  
The adaptive difficulty system shall read all tunable algorithm parameters — including `windowSizeUp`, `windowSizeDown`, `tierUpThreshold`, `tierDownThreshold`, `correctRateWeight`, and `speedWeight` — from the DynamoDB config item with key `CONFIG#ALGO_PARAMS / V0` rather than hard-coding them in Lambda source code.

> Source: adaptive-difficulty.md §9.2 — "All algorithm parameters are externalised as a DynamoDB Config item (`CONFIG#ALGO_PARAMS / V0`)".

**DIFF-024** `[ ]`  
The SubmitAnswer Lambda shall cache the `CONFIG#ALGO_PARAMS` item in Lambda memory between warm invocations and shall refresh this cache no more frequently than every 5 minutes.

> Source: adaptive-difficulty.md §9.2 — "cached in Lambda memory between warm invocations with a 5-minute TTL".

---

## 10. Partial Window Behaviour

**DIFF-025** `[ ]`  
While the user has fewer than 20 attempts at the current tier, the adaptive difficulty system shall compute the composite score over all available current-tier attempts but shall not trigger a tier-up transition.

> Source: adaptive-difficulty.md §6.1 — "The tier-up rule requires exactly `|W| == 20`"; §4.5 Step 4a — "`|window| == 20`" guard.

**DIFF-026** `[ ]`  
While the user has fewer than 10 attempts at the current tier, the adaptive difficulty system shall compute the composite score over all available current-tier attempts but shall not trigger a tier-down transition.

> Source: adaptive-difficulty.md §4.5 Step 5c — "`|window| == 10`" guard; §6.1.

---

## 11. Speed Score Median Refresh

**DIFF-027** `[ ]`  
The adaptive difficulty system shall compute per-difficulty median response times through an offline scheduled process (the ComputeMedians Lambda) and shall not compute or update medians inline within the SubmitAnswer Lambda.

> Source: adaptive-difficulty.md §5.5 — "Median recomputation is performed by an offline process".

**DIFF-028** `[ ]`  
The ComputeMedians Lambda shall be triggered by an EventBridge scheduled rule on a recurring cadence (default: every 24 hours) and shall overwrite the `SPEED_MEDIANS` config item in DynamoDB with freshly computed medians and an updated `computedAt` timestamp upon each successful run.

> Source: adaptive-difficulty.md §5.5.

**DIFF-029** `[ ]`  
The ComputeMedians Lambda shall include in the median computation only attempt records where `timeTakenMs` falls within the range [3000, 600000] ms inclusive, excluding values outside this range as outliers.

> Source: adaptive-difficulty.md §5.2.

**DIFF-030** `[ ]`  
The ComputeMedians Lambda shall store the number of valid attempts used to compute each per-tier median in the `sampleSizes` map within the `SPEED_MEDIANS` config item, enabling the SubmitAnswer Lambda to determine whether each median is established.

> Source: adaptive-difficulty.md §5.3 — `sampleSizes` attribute.

**DIFF-031** `[ ]`  
When the SubmitAnswer Lambda reads updated median values from DynamoDB mid-session (because the scheduled refresh ran between two of a user's attempts), the adaptive difficulty system shall apply the new median values when computing the rolling window score over all attempts' stored `timeTakenMs` values on the next invocation; previously written attempt records shall not be retroactively rescored.

> Source: adaptive-difficulty.md §5.6.

---

## 12. timeTakenMs Clamping

**DIFF-032** `[ ]`  
When a SubmitAnswer request supplies a `timeTakenMs` value of 0 or a positive integer not exceeding 600000, the adaptive difficulty system shall accept the value; when `timeTakenMs` exceeds 600000, the system shall clamp it to 600000 before persisting the attempt record and before computing the speed score.

> Source: api.md §4.2 field constraints — "max 600000 … anything above is clamped to 600000"; §4.4 Step 1 — "`timeTakenMs` is clamped to 600000 after validation".

**DIFF-033** `[ ]`  
When a SubmitAnswer request supplies a `timeTakenMs` value that is not a non-negative integer (for example, a negative number, a non-integer float, or a missing field), the adaptive difficulty system shall reject the request with HTTP 400 and error code `INVALID_TIME_TAKEN` without recording an attempt.

> Source: api.md §4.3 error table — "`timeTakenMs` missing or not a non-negative integer → 400 INVALID_TIME_TAKEN".

**DIFF-034** `[ ]`  
The adaptive difficulty system shall persist the clamped value of `timeTakenMs` to the attempt record in DynamoDB, not the raw client-supplied value.

> Source: api.md §4.4 Step 1 — "The raw client value is not persisted uncapped"; §4.8 TransactWriteItems — uses `clampedTimeTaken`.

---

## 13. GetProgress Response

**DIFF-035** `[ ]`  
The GetProgress Lambda shall return the user's current tier as the value of the `currentTier` field in the HTTP 200 response.

> Source: api.md §5.3 response contract.

**DIFF-036** `[ ]`  
The GetProgress Lambda shall return the rolling composite score, rolling correct rate, and rolling speed score computed over the user's most recent attempts (up to 20) in the `rolling` object of the HTTP 200 response.

> Source: api.md §5.3 — `rolling.compositeScore`, `rolling.correctRate`, `rolling.speedScore`.

**DIFF-037** `[ ]`  
The GetProgress Lambda shall return the `attemptsUntilUpgrade` field as a non-negative integer estimate of how many additional high-scoring attempts are required for the next tier promotion, or `null` if the user is at the ADVANCED tier or a promotion is not currently achievable within the projection horizon.

> Source: api.md §5.3 — `rolling.attemptsUntilUpgrade`; §5.4 Step 3.

**DIFF-038** `[ ]`  
The GetProgress Lambda shall return the `attemptsUntilDowngrade` field as a non-negative integer estimate of how many additional low-scoring attempts would trigger a tier demotion, or `null` if the user is at the BEGINNER tier or a demotion is not currently at risk within the projection horizon.

> Source: api.md §5.3 — `rolling.attemptsUntilDowngrade`; §5.4 Step 3.

**DIFF-039** `[ ]`  
The GetProgress Lambda shall return the size of the window used to compute the rolling scores in the `rolling.windowSize` field.

> Source: api.md §5.3 response contract — `rolling.windowSize`.

---

## 14. GetSnippet Tier Filtering

**DIFF-040** `[ ]`  
When a user calls GetSnippet, the adaptive difficulty system shall select candidate snippets by querying the Snippets table restricted to the difficulty tier recorded as `currentTier` in the user's profile at the time of the request.

> Source: adaptive-difficulty.md §7.3 — "GetSnippet reads `currentTier` from the Users record and uses it to filter the Snippets table via the difficulty GSI"; api.md §3.4 Step 2.

**DIFF-041** `[ ]`  
The GetSnippet Lambda shall perform no tier evaluation or scoring computation; it shall treat the stored `currentTier` value as authoritative for snippet selection.

> Source: adaptive-difficulty.md §7.3.

---

## 15. Window Reset on Tier Transition

**DIFF-042** `[ ]`  
When a tier transition occurs, the adaptive difficulty system shall not delete or modify any existing attempt records; the scoring window for the new tier shall begin empty and accumulate only attempts recorded after the transition, filtered by `tierId = newTier` and `timestamp > lastTransitionTimestamp`.

> Source: adaptive-difficulty.md §4.4.

**DIFF-043** `[ ]`  
The adaptive difficulty system shall store the Unix epoch millisecond timestamp of the most recent tier transition in the `lastTransitionTimestamp` attribute of the user's PROFILE record, updated atomically with the `currentTier` change on every promotion or demotion.

> Source: adaptive-difficulty.md §6.3 — window query filters on `tierId = currentTier AND timestamp > lastTransitionTimestamp`; §8.1 attribute list.

---

## Consistency Report

### Coverage Gaps

**CG-1: Boundary value for `timeTakenMs` validation (zero vs. positive).**  
The api.md field constraints say `min 0` (allowing zero), while adaptive-difficulty.md §6.5 states that `timeTakenMs ≤ 0` is rejected with a 400. These two sources contradict each other on whether zero is valid. DIFF-032 and DIFF-033 follow the api.md contract (zero is accepted), but this needs explicit product resolution. If zero is rejected, DIFF-033 should be updated and DIFF-032 amended to state `min 1`.

**CG-2: Fallback when `SPEED_MEDIANS` config item is absent.**  
adaptive-difficulty.md §6.2 (Edge Case Probe question 2) and api.md §8.1 question 4 both raise the missing-config-item scenario but leave the behaviour unresolved (fail with 500 vs. fall back to 0.5 default). No spec covers this failure mode. A `DIFF` should be added once a decision is made.

**CG-3: Fallback median for unestablished ADVANCED tier.**  
adaptive-difficulty.md §10 question 4 asks whether the INTERMEDIATE median should be used for ADVANCED when ADVANCED has fewer than 100 samples. The current specs (DIFF-011) default all unestablished tiers to 0.5 neutrally, but if a tiered fallback (e.g. ADVANCED uses INTERMEDIATE median) is preferred, a new spec is needed.

**CG-4: Attempt deduplication / replay window.**  
adaptive-difficulty.md §2.1 mentions a "5-second session replay window" for duplicate `snippetId + userId` submissions. No DIFF covers the rule that duplicate submissions within that window are rejected and not recorded. This is a testable behaviour with scoring implications.

**CG-5: `attemptsUntilUpgrade` / `attemptsUntilDowngrade` computation algorithm.**  
DIFF-037 and DIFF-038 specify the output semantics but not the forward-simulation algorithm used to compute estimates (described in api.md §5.4 Step 3). The algorithm involves hypothetical perfect-score or zero-score attempts; its boundary conditions (cap at 20, definition of "not achievable") are not fully formalised in either source document.

**CG-6: ALGO_PARAMS item absence at startup.**  
adaptive-difficulty.md §9.2 says the item is "seeded by the snippet loader script or a one-time setup command" but does not define Lambda behaviour if the item is missing. No spec covers this operational failure mode.

**CG-7: Tier transition event record.**  
adaptive-difficulty.md §8.3 defines a `TRANSITION#` event record written to DynamoDB on every promotion or demotion. No DIFF covers the requirement to write this record. It is testable and affects audit trails.

---

### Contradictions

**CONT-1: `timeTakenMs` minimum accepted value.**  
As noted in CG-1, adaptive-difficulty.md §6.5 requires `timeTakenMs` to be a positive integer (minimum 1), while api.md §4.2 states `min 0`. The two source documents are inconsistent. The specs (DIFF-032/033) follow api.md as the more authoritative API contract document; the adaptive-difficulty.md text should be updated to match.

**CONT-2: Speed score formula orientation.**  
adaptive-difficulty.md §3.3 defines `rawSpeed = M(d) / t` (median divided by time, rewarding faster responses), and maps [0,2] → [0,1] by dividing by 2. api.md §4.4 Step 6 describes the formula differently as `ratio = t / median` (time divided by median) with `Math.max(0, Math.min(1, 2 - ratio))`. Both produce identical numeric results for valid inputs, but the intermediate variable `ratio` has opposite semantics. DIFF-007 follows the adaptive-difficulty.md formulation; the api.md pseudocode should be aligned for clarity.

**CONT-3: `CONFIG` item key format.**  
adaptive-difficulty.md §5.3 uses `PK = CONFIG`, `SK = SPEED_MEDIANS` for the median config item. api.md §2.3 uses `PK = CONFIG#SPEED_MEDIANS`, `SK = LATEST`. These are different DynamoDB key structures for the same logical item. DIFF-010 follows adaptive-difficulty.md; the two LLDs must be reconciled before implementation.

---

### Implicit Scoping Issues

**IS-1: Server-side-only computation.**  
The specs do not explicitly prohibit client-side tier computation. A security-oriented spec stating "The adaptive difficulty system shall perform all tier evaluation exclusively within the SubmitAnswer Lambda; no tier evaluation logic shall execute on the client" would close this gap (backed by adaptive-difficulty.md §7.1).

**IS-2: Scope of `tierId` filter on window query.**  
DIFF-042 and DIFF-043 implicitly require the window query to filter by both `tierId = currentTier` and `timestamp > lastTransitionTimestamp`. A user who re-reaches a tier after a round-trip demotion-then-promotion could have old same-tier attempts that are older than `lastTransitionTimestamp`. The specs do not make the timestamp filter explicit enough to prevent implementors from filtering by `tierId` alone, which would wrongly include pre-demotion attempts.

**IS-3: `compositeScore` boundary at exactly 0.40.**  
DIFF-016 uses "strictly less than 0.40" for the tier-down trigger. api.md §8.4 question 15 notes that `compositeScore == 0.40` exactly does not trigger a downgrade. The boundary condition is consistent between the spec and source document, but it should be documented as an explicit product decision to prevent future off-by-one bugs.

**IS-4: Unit of `attemptsUntilUpgrade` / `attemptsUntilDowngrade`.**  
DIFF-037 and DIFF-038 define these as "estimates". The source documents describe them as "best-effort approximations … not a guarantee." The specs should note that these values are advisory only and that the actual transition is determined solely by the SubmitAnswer evaluation. Currently the specs are silent on the advisory-only nature, which could lead to implementations that treat these counts as guarantees.
