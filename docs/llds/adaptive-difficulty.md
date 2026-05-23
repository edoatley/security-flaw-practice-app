# Low-Level Design: Adaptive Difficulty Algorithm

**Component:** Adaptive Difficulty Algorithm
**Parent HLD:** high-level-design.md v0.2
**Version:** 0.1 (Draft)
**Date:** 2026-05-16
**Author:** edoatley@gmail.com

---

## Table of Contents

1. [Overview](#1-overview)
2. [Rolling Window Computation](#2-rolling-window-computation)
3. [Composite Score Formula](#3-composite-score-formula)
4. [Tier Transition State Machine](#4-tier-transition-state-machine)
5. [Speed Score Normalisation and Median Management](#5-speed-score-normalisation-and-median-management)
6. [Edge Cases](#6-edge-cases)
7. [Computation Location](#7-computation-location)
8. [DynamoDB Read/Write Patterns](#8-dynamodb-readwrite-patterns)
9. [Decisions and Alternatives](#9-decisions-and-alternatives)
10. [Edge Case Probe](#10-edge-case-probe)

---

## 1. Overview

The adaptive difficulty algorithm adjusts each user's active difficulty tier (BEGINNER, INTERMEDIATE, or ADVANCED) automatically after every answer submission. It uses a composite rolling-window score that combines correctness and answer speed to decide whether the user should progress to a harder tier or fall back to an easier one.

The algorithm runs entirely within the `SubmitAnswer` Lambda function on every call. No client-side computation is permitted. The outcome — the user's current tier — is persisted to the Users DynamoDB table and is the authoritative source read by `GetSnippet` when selecting the next question.

---

## 2. Rolling Window Computation

### 2.1 What Counts as an Attempt

An attempt is any completed call to `POST /api/answer` that:

- passes API Gateway JWT authorisation,
- references a valid `snippetId` in the Snippets table, and
- produces a definitive correct/incorrect result written to the Users table.

Abandoned sessions (no submission), duplicate submissions of the same `snippetId + userId` within a session replay window (5 seconds), and server-error-rejected requests are **not** recorded and do **not** count as attempts.

Each attempt record written to DynamoDB contains:

| Attribute | Type | Description |
|---|---|---|
| `userId` | String (PK) | Cognito sub |
| `attemptId` | String (SK) | `ATTEMPT#<ISO-8601 timestamp>#<UUID suffix>` |
| `snippetId` | String | The snippet answered |
| `timestamp` | Number | Unix epoch milliseconds |
| `correct` | Boolean | Whether the answer was fully correct |
| `timeTakenMs` | Number | Elapsed ms from snippet delivery to submission |
| `tierId` | String | The user's active tier at the time of this attempt |

### 2.2 How the Window Slides

The rolling window is always the **most recent N attempts by timestamp**, where N = 20 for tier-up evaluation and N = 10 for tier-down evaluation.

The window slides forward on every new attempt: the oldest attempt beyond the window boundary is simply not included in the score calculation. No attempt records are deleted or mutated; the window is a logical view over the ordered list of attempts.

**Sliding behaviour:**

```
Attempt history (oldest → newest):  a1 a2 a3 ... a18 a19 a20 a21
                                                              ↑ new attempt

Window-of-20 before a21: [a2 ... a21]   (a1 drops off)
Window-of-20 after  a21: [a2 ... a21]   ✓
```

When a user has fewer than 20 total attempts, the window is simply all available attempts (see Section 6.1).

### 2.3 Attempt Ordering

Attempts are ordered by the `timestamp` attribute (Unix epoch ms). Because DynamoDB sorts within a partition by SK lexicographically and SK is prefixed with `ATTEMPT#<ISO-8601>`, a query in ascending SK order naturally returns attempts in chronological order. The Lambda reads the most recent 20 (or 10) using a descending query with `Limit`, then reverses in memory to get oldest-first order for score calculation.

---

## 3. Composite Score Formula

### 3.1 Definitions

| Symbol | Meaning |
|---|---|
| W | Window of attempts being scored (ordered list) |
| \|W\| | Number of attempts in the window |
| Cᵢ | 1 if attempt i was correct, 0 otherwise |
| tᵢ | `timeTakenMs` for attempt i |
| dᵢ | `tierId` (difficulty tier) at the time of attempt i |
| M(d) | Median `timeTakenMs` across all historical attempts at difficulty d (stored in DynamoDB Config table) |

### 3.2 Correct Rate

```
correctRate = (Σ Cᵢ for i in W) / |W|
```

This is a plain proportion in [0, 1].

### 3.3 Speed Score per Attempt

The speed score for a single attempt measures how much faster (or slower) the user was compared to the population median at that difficulty. It is normalised to a [0, 1] scale.

**Formula:**

```
rawSpeed(i) = M(dᵢ) / tᵢ

speedScore(i) = clamp(rawSpeed(i), 0, 2) / 2
```

Where `clamp(x, lo, hi)` returns `lo` if x < lo, `hi` if x > hi, else x.

**Rationale for the cap at 2:**
A ratio of 2 means "twice as fast as the median". Values beyond 2 get no further reward — this prevents gaming by immediately clicking without reading. The division by 2 maps the [0, 2] raw range to [0, 1].

**When median data is unavailable** for difficulty d, `speedScore(i) = 0.5` (neutral; see Section 5.4).

### 3.4 Window Speed Score

```
windowSpeedScore = (Σ speedScore(i) for i in W) / |W|
```

This is the mean of per-attempt speed scores across the window.

### 3.5 Composite Score

```
compositeScore = 0.70 × correctRate + 0.30 × windowSpeedScore
```

Output range: [0, 1].

### 3.6 Worked Numeric Example

**Scenario:** A BEGINNER user has completed 20 attempts. The DynamoDB Config record shows `medianTimeBeginner = 45000` ms (45 seconds).

| # | Correct | timeTakenMs | rawSpeed | speedScore |
|---|---|---|---|---|
| 1 | 1 | 60000 | 45000/60000 = 0.75 | clamp(0.75,0,2)/2 = 0.375 |
| 2 | 1 | 30000 | 45000/30000 = 1.50 | clamp(1.50,0,2)/2 = 0.750 |
| 3 | 0 | 90000 | 45000/90000 = 0.50 | clamp(0.50,0,2)/2 = 0.250 |
| 4–20 | 1 (17 more) | 40000 each | 45000/40000 = 1.125 | 1.125/2 = 0.5625 each |

**Step 1 — Correct rate:**
```
correctCount = 1 + 1 + 0 + 17 = 19
correctRate  = 19 / 20 = 0.95
```

**Step 2 — Window speed score:**
```
sumSpeedScores = 0.375 + 0.750 + 0.250 + (17 × 0.5625)
               = 0.375 + 0.750 + 0.250 + 9.5625
               = 10.9375

windowSpeedScore = 10.9375 / 20 = 0.5469
```

**Step 3 — Composite score:**
```
compositeScore = 0.70 × 0.95 + 0.30 × 0.5469
               = 0.665 + 0.1641
               = 0.829
```

**Result:** 0.829 ≥ 0.75 → this window qualifies as a tier-up window. If 20 consecutive attempts have all produced a score ≥ 0.75, the user is promoted to INTERMEDIATE.

### 3.7 Boundary Examples

| Scenario | compositeScore | Outcome |
|---|---|---|
| All correct, all at 2× median speed | 0.70×1 + 0.30×1 = **1.00** | Maximum score |
| All correct, all at 0× speed (timed out, capped neutral) | 0.70×1 + 0.30×0.5 = **0.85** | Still above tier-up threshold |
| All wrong, all slow | 0.70×0 + 0.30×0 = **0.00** | Well below tier-down threshold |
| 40% correct, median speed | 0.70×0.4 + 0.30×0.5 = **0.43** | Just above tier-down threshold (0.40); no transition |
| 38% correct, median speed | 0.70×0.38 + 0.30×0.5 = **0.416** | Slightly above 0.40; still no tier-down |
| 28% correct, median speed | 0.70×0.28 + 0.30×0.5 = **0.346** | Below 0.40 → counts toward tier-down run |

---

## 4. Tier Transition State Machine

### 4.1 Valid States and Transitions

```
                     score ≥ 0.75
                    (20 consecutive)
     ┌─────────────────────────────────────────────┐
     │                                             ▼
 ┌───┴───────┐  score ≥ 0.75 (20)  ┌──────────────┐  score ≥ 0.75 (20)  ┌──────────┐
 │  BEGINNER │──────────────────►  │ INTERMEDIATE │──────────────────►  │ ADVANCED │
 └───────────┘                     └──────────────┘                     └──────────┘
                                          ▲                                   │
                                          │  score < 0.40                     │
                                          │  (10 consecutive)                 │
                                          └───────────────────────────────────┘
                    score < 0.40
                   (10 consecutive)
     ┌─────────────────────────────────────────────┐
     │                                             │
 ┌───┴───────┐ ◄───────────────────  ┌─────────────┴────┐
 │  BEGINNER │                       │  INTERMEDIATE    │
 └───────────┘                       └──────────────────┘
```

### 4.2 Transition Conditions (Formal)

**Tier-up (promotion):**
The last 20 consecutive attempts (the full window) must each individually produce a `compositeScore ≥ 0.75`. The score is computed for the window ending at each attempt; all 20 must pass.

In practice this is implemented as: after computing the window score for the current 20-attempt window, if `compositeScore ≥ 0.75` **and** the user has had at least 20 attempts at the current tier without a tier-down event intervening, promotion is triggered. See Section 4.5 for the exact evaluation order.

**Tier-down (demotion):**
The last 10 consecutive attempts (a sub-window) must each individually produce a `compositeScore < 0.40` when scored over the most recent 10 attempts. This is evaluated using a separate 10-attempt window.

### 4.3 Transition Not Permitted

- BEGINNER → ADVANCED (must pass through INTERMEDIATE)
- ADVANCED → BEGINNER (must pass through INTERMEDIATE)
- Any tier → the same tier (a "no-op" is the expected outcome on most calls)

### 4.4 What Happens to the Window on Transition

On a tier transition the attempt history is **not cleared**. All prior attempt records remain in DynamoDB and remain queryable for analytics. However, for the purpose of the rolling-window scoring the window resets implicitly: the next tier evaluation reads only the most recent attempts at the **new** tier using the `tierId` filter (see Section 2.3 and Section 8.2). Attempts recorded at a previous tier are excluded from the scoring window.

This means:
- After promotion from BEGINNER to INTERMEDIATE, the 20-attempt window starts empty for INTERMEDIATE scoring purposes. The user must accumulate 20 INTERMEDIATE attempts before the full window can drive another promotion.
- After demotion from INTERMEDIATE to BEGINNER, the BEGINNER scoring window similarly starts fresh.

### 4.5 Evaluation Order Within SubmitAnswer

The `SubmitAnswer` Lambda runs the following sequence atomically from the user's perspective (each step is a DynamoDB operation or in-memory computation):

```
1. Write new attempt record (with tierId = currentTier from Users record)
2. Query the last 20 attempt records where tierId = currentTier (ascending timestamp)
3. Compute compositeScore over those 20 (or fewer) attempts
4. Evaluate tier-up condition:
   a. If |window| == 20 AND compositeScore ≥ 0.75 → trigger promotion
5. Evaluate tier-down condition (only if tier-up was NOT triggered):
   a. Query the last 10 attempt records where tierId = currentTier
   b. Compute compositeScore over those 10 (or fewer) attempts
   c. If |window| == 10 AND compositeScore < 0.40 → trigger demotion
6. If a transition was triggered:
   a. Update Users record: set currentTier = newTier
   b. Record a TierTransition event (see Section 8.3)
7. Return HTTP response including: correct, explanation, currentTier, compositeScore
```

Note that the 10-attempt window for tier-down is a fresh query rather than a slice of the 20-attempt query result; this avoids off-by-one errors if fewer than 20 attempts exist at the current tier.

### 4.6 Hysteresis

The threshold gap between tier-up (≥ 0.75) and tier-down (< 0.40) provides built-in hysteresis. A user scoring in the range [0.40, 0.75) will not trigger either transition regardless of how many consecutive attempts fall in that band. This prevents rapid oscillation between tiers for users near a boundary.

---

## 5. Speed Score Normalisation and Median Management

### 5.1 Why Per-Difficulty Medians

Time-to-answer is strongly correlated with snippet difficulty: ADVANCED snippets are longer and have subtler vulnerabilities, so all users take longer regardless of ability. Using a per-difficulty median calibrates the speed component so that a "fast" ADVANCED attempt and a "fast" BEGINNER attempt both score similarly on the speed dimension.

### 5.2 What Data Is Used to Compute Medians

Medians are computed from **all recorded attempt records** for a given difficulty tier, across all users. The raw `timeTakenMs` values for each `tierId` are aggregated offline.

Only attempts where `timeTakenMs` is within a plausible range are included:
- Minimum: 3000 ms (3 seconds) — below this is assumed to be an automation or accidental click
- Maximum: 600000 ms (10 minutes) — above this the tab was likely left idle; outliers skew the median less than the mean but are still excluded for hygiene

### 5.3 How Medians Are Stored

A dedicated DynamoDB item in the Users table (or a Config table if one is added) stores the current median values:

| Attribute | Value |
|---|---|
| PK | `CONFIG#SPEED_MEDIANS` |
| SK | `V0` |
| `value.BEGINNER` | Number (ms) — median for BEGINNER tier |
| `value.INTERMEDIATE` | Number (ms) — median for INTERMEDIATE tier |
| `value.ADVANCED` | Number (ms) — median for ADVANCED tier |
| `value.sampleSizes` | Map: `{BEGINNER: N, INTERMEDIATE: N, ADVANCED: N}` |
| `value.computedAt` | ISO-8601 timestamp |
| `updatedAt` | ISO-8601 timestamp |

The `sampleSizes` attribute records how many valid attempts were used to compute each median. This is used to decide whether the data is sufficient (see Section 5.4).

### 5.4 Bootstrap / Cold Start: Insufficient Data

A median is considered **established** when `sampleSize ≥ 100` for that difficulty tier. Until this threshold is met, the speed score for all attempts at that tier defaults to `0.5` (neutral — effectively removing the speed component from that tier's composite score without penalising the user).

The cold-start ladder:
- At launch, all three medians are unestablished → all speed scores are 0.5 → composite score ≈ `0.70 × correctRate + 0.30 × 0.5`
- BEGINNER will reach the 100-attempt threshold first (most traffic); once established, BEGINNER speed scores become real
- INTERMEDIATE and ADVANCED follow as population grows

The `SPEED_MEDIANS` config item is **always present** in DynamoDB (written by the deployment script with initial values of `null` and `sampleSizes` of 0). The Lambda checks `sampleSize < 100` at read time and substitutes the neutral default.

### 5.5 How and When Medians Are Refreshed

Median recomputation is performed by an **offline process**, not inline in the SubmitAnswer Lambda. The options are:

- **Scheduled Lambda (chosen):** An EventBridge rule triggers a `ComputeMedians` Lambda on a cron schedule (e.g. every 24 hours). This Lambda performs a full scan of all attempt records, filters to the plausible range, computes the median per tier using a sort-and-pick approach, and overwrites the `SPEED_MEDIANS` config item.
- The 24-hour refresh cadence means medians may lag reality by up to a day. This is acceptable: medians shift slowly as the user population and content library evolve.
- The `computedAt` timestamp on the config item allows operators to detect stale data (e.g. if the scheduled job fails).

**Median computation algorithm (ComputeMedians Lambda):**

```python
def compute_median(values: list[int]) -> int:
    if not values:
        return None
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 0:
        return (sorted_vals[mid - 1] + sorted_vals[mid]) // 2
    return sorted_vals[mid]
```

For large datasets (> 1M attempts per tier) this scan is expensive. The acceptable DynamoDB Scan cost at v1 scale is low enough to tolerate; at larger scale a stream-based incremental approach would be substituted (see Section 9).

### 5.6 Median Staleness and Live Speed Scores

Speed scores are computed at attempt submission time using whatever median is current in the config item. If the median is refreshed mid-session, subsequent attempts within that session use the new median. Attempts already written to DynamoDB are not retroactively rescored; the rolling-window score is always computed fresh from the stored `timeTakenMs` values and the current median.

---

## 6. Edge Cases

### 6.1 First N Attempts (Window Not Full)

When a user has fewer than 20 attempts at the current tier, the window contains all available attempts. The composite score is still computed over `|W|` attempts. The tier-up rule requires exactly `|W| == 20`, so a promotion can only fire once the window is full. The tier-down rule requires exactly `|W| == 10` (or more; the query uses `Limit=10` so if ≥ 10 exist, the condition is evaluable).

**Implication:** a brand-new user cannot be promoted until they have answered 20 questions. They can be demoted after 10 incorrect or slow answers if they somehow arrived at INTERMEDIATE (which cannot happen from BEGINNER without 20 answers, so in practice demotion is also deferred until 10 answers exist at the current tier).

**New users** are written to the Users table by a Cognito post-confirmation trigger or on first `GetSnippet` call with `currentTier = BEGINNER` and no attempt records.

### 6.2 All Attempts at One Difficulty

A user who has answered all 20 window attempts at BEGINNER and then is promoted to INTERMEDIATE has, by definition, zero INTERMEDIATE attempts. The `tierId` filter on window queries ensures the INTERMEDIATE window starts empty. This is the normal expected case and is handled by the `|W| < 20` guard on promotion.

If a user stalls at BEGINNER for hundreds of attempts without ever promoting (score consistently in [0.40, 0.75)), no tier change fires. This is correct by design — the algorithm does not force progression.

### 6.3 User Who Switches Tiers and Returns

**Scenario:** User promotes BEGINNER → INTERMEDIATE, answers 15 INTERMEDIATE questions, demotes to BEGINNER, then later re-promotes to INTERMEDIATE.

On re-promotion the INTERMEDIATE window starts fresh (zero INTERMEDIATE attempts post-re-promotion). The 15 earlier INTERMEDIATE attempts are visible in DynamoDB history but are **excluded** from the scoring window because they carry a `tierId = INTERMEDIATE` value timestamped before the demotion event.

To correctly distinguish pre-demotion and post-re-promotion INTERMEDIATE attempts, the window query filters on `tierId = INTERMEDIATE` AND `timestamp > lastTransitionTimestamp`. The `lastTransitionTimestamp` is read from the Users record (see Section 8.1 for the attribute list).

This means the Users record must store the timestamp of the most recent tier transition, updated on every promotion or demotion.

### 6.4 Identical Timestamps

If two attempt records share the same millisecond timestamp (unlikely but possible under concurrent load), the SK tiebreak (UUID suffix) ensures DynamoDB returns them in a consistent order. The scoring algorithm treats them as distinct attempts and processes them in SK lexicographic order, which is deterministic.

### 6.5 timeTakenMs of Zero or Negative

If a client clock skew or replay attack results in `timeTakenMs ≤ 0`, the attempt is rejected by the input validation in `SubmitAnswer` with a 400 response. Validation: `timeTakenMs` must be a positive integer. The attempt is not recorded.

### 6.6 Snippet Repeated in Window

A user may see the same snippet more than once (e.g. the snippet pool is small). Each submission is a distinct attempt record with its own `attemptId` and timestamp. Repetition is not filtered out — repeated correct answers on familiar snippets are intentionally rewarded, as recall under time pressure is still a valid signal.

### 6.7 Mid-Window Config Change

If the `medianBeginner` value in the `SPEED_MEDIANS` config item is updated by the scheduled job while a user is mid-window (i.e. 10 of their 20 window attempts were scored with the old median), the next `SubmitAnswer` call re-reads the config and uses the new median for computing the rolling window score over all 20 attempts' `timeTakenMs` values. The stored `timeTakenMs` is the raw measurement; only the median used for normalisation changes.

---

## 7. Computation Location

### 7.1 All Scoring Runs Server-Side in SubmitAnswer Lambda

The adaptive difficulty computation runs exclusively in the `SubmitAnswer` Lambda function. The client receives only the result (current tier, composite score summary) in the HTTP response; it performs no scoring logic.

**Reasons:**

| Concern | Why Lambda, Not Client |
|---|---|
| Integrity | A client-side tier calculation can be trivially manipulated by a malicious user sending crafted payloads to inflate their tier |
| Answer key security | The Lambda already has access to the answer key for validation; scoring is a natural extension |
| Consistency | A single authoritative calculation location eliminates drift if the algorithm is updated |
| Latency | The DynamoDB reads required (attempt history, speed medians) are sub-millisecond within the same AWS region; not feasible from the browser |

### 7.2 GetProgress Lambda

`GetProgress` does **not** re-run the tier evaluation algorithm. It reads the `currentTier` field already written to the Users record by the most recent `SubmitAnswer` call. This keeps `GetProgress` a cheap read-only operation and avoids any possibility of the two Lambdas computing conflicting tier values.

### 7.3 GetSnippet Lambda

`GetSnippet` reads `currentTier` from the Users record and uses it to filter the Snippets table via the difficulty GSI. No scoring logic runs here.

---

## 8. DynamoDB Read/Write Patterns

### 8.1 Users Record Structure (Relevant Attributes)

```json
{
  "PK": "USER#<cognitoSub>",
  "SK": "PROFILE",
  "currentTier": "BEGINNER",
  "totalAttempts": 42,
  "correctAttempts": 35,
  "lastTransitionTimestamp": 1747382400000,
  "lastTransitionType": "PROMOTION",
  "createdAt": 1747300000000
}
```

### 8.2 Attempt Records Structure

```json
{
  "PK": "USER#<cognitoSub>",
  "SK": "ATTEMPT#2026-05-16T10:30:00.000Z#<uuidSuffix>",
  "snippetId": "snp-abc123",
  "timestamp": 1747391400000,
  "correct": true,
  "timeTakenMs": 32000,
  "tierId": "BEGINNER"
}
```

### 8.3 Tier Transition Event Records

Written to the same partition as the user's attempts on every promotion or demotion:

```json
{
  "PK": "USER#<cognitoSub>",
  "SK": "TRANSITION#2026-05-16T11:00:00.000Z#<uuidSuffix>",
  "fromTier": "BEGINNER",
  "toTier": "INTERMEDIATE",
  "triggerType": "PROMOTION",
  "compositeScore": 0.829,
  "windowSize": 20,
  "timestamp": 1747393200000
}
```

### 8.4 Speed Medians Config Record

```json
{
  "PK": "CONFIG",
  "SK": "SPEED_MEDIANS",
  "medianBeginner": 45000,
  "medianIntermediate": 72000,
  "medianAdvanced": 110000,
  "computedAt": "2026-05-15T00:00:00Z",
  "sampleSizes": {
    "BEGINNER": 1240,
    "INTERMEDIATE": 430,
    "ADVANCED": 88
  }
}
```

### 8.5 SubmitAnswer Read Pattern

On each `SubmitAnswer` invocation the Lambda performs the following DynamoDB operations in order:

1. **GetItem** — Users PROFILE record → read `currentTier`, `lastTransitionTimestamp`
2. **GetItem** — CONFIG / SPEED_MEDIANS → read medians and sample sizes
3. **GetItem** — Snippets table → validate answer (already required for correctness check)
4. **PutItem** — write new attempt record
5. **Query** — `PK = USER#<sub>`, `SK begins_with "ATTEMPT#"`, `ScanIndexForward = false`, `Limit = 20`, filter `tierId = currentTier` AND `timestamp > lastTransitionTimestamp` → fetch last 20 current-tier attempts
6. Compute composite score in-memory over result set
7. **Query** (conditional) — if |result set| ≥ 10, re-use the last 10 items from step 5 for tier-down evaluation (no second DynamoDB call needed)
8. **UpdateItem** (conditional) — if a tier transition was triggered: update `currentTier`, `lastTransitionTimestamp`, `lastTransitionType` on PROFILE record
9. **PutItem** (conditional) — if a tier transition was triggered: write TRANSITION event record

**Total DynamoDB operations per SubmitAnswer call:** 4 unconditional reads/writes + up to 2 conditional writes = 4–6 operations.

### 8.6 Consistency Considerations

- Steps 1 and 4 operate on different items (PROFILE vs. ATTEMPT record) so they cannot be combined into a single transaction without cost.
- The PROFILE update in step 8 uses a **conditional UpdateItem** with `currentTier = :expected` as the condition expression. If a race condition causes two concurrent `SubmitAnswer` calls to both compute a tier transition, only the first write wins; the second fails the condition check and proceeds without updating the tier. This is safe: the worst outcome is a delayed tier transition, caught on the next attempt.
- DynamoDB **eventual consistency** is acceptable for the attempt Query (step 5) because the new attempt written in step 4 may not appear in the query result within the same Lambda invocation. This is intentional: the new attempt is the 21st in the window and the query reads only 20, so the just-written attempt will influence scoring on the next invocation.

---

## 9. Decisions and Alternatives

### 9.1 Rolling Window vs. Streak Counting

| Approach | Pros | Cons |
|---|---|---|
| **Rolling window (chosen)** | Smooths noise; a single lucky correct answer doesn't immediately promote | More complex to query; window boundary logic at tier transition |
| Streak counting | Simple to implement; easy to explain to the user | Brittle: one wrong answer resets streak; discourages risk-taking on hard snippets |
| Exponential moving average | Even smoother; weights recent attempts more | Opaque to users; hard to communicate "you need X more correct answers" |

Rolling window was chosen because it matches the HLD specification and strikes a balance between responsiveness and stability.

### 9.2 Composite Score vs. Correct-Rate Only

| Approach | Pros | Cons |
|---|---|---|
| **Composite (70% correct + 30% speed) (chosen)** | Rewards efficient recall, not just eventual correctness; matches real-world security review skills | Speed signal is noisy (network latency, tab switching); requires median infrastructure |
| Correct-rate only | Simple; robust to latency variance | Ignores time; a user who takes 10 minutes per question is indistinguishable from one who answers in 5 seconds |
| Speed only | Penalises careful readers; clearly wrong | — |

Composite score was chosen per the HLD. The 70/30 weighting was specified in the HLD and acknowledges that correctness is the primary signal.

**All algorithm parameters are externalised as a DynamoDB Config item** (`CONFIG#ALGO_PARAMS / V0`) so they can be tuned without a Lambda deployment. Parameters include: `windowSizeUp` (default 20), `windowSizeDown` (default 10), `tierUpThreshold` (default 0.75), `tierDownThreshold` (default 0.40), `correctRateWeight` (default 0.70), `speedWeight` (default 0.30). The `SubmitAnswer` Lambda reads this item on every invocation (cached in Lambda memory between warm invocations with a 5-minute TTL). Initial values are seeded by the snippet loader script or a one-time setup command.

### 9.3 Symmetric vs. Asymmetric Thresholds

The HLD specifies asymmetric thresholds: tier-up requires score ≥ 0.75 over 20 attempts; tier-down requires score < 0.40 over 10 attempts. Alternatives:

| Option | Rationale for rejection |
|---|---|
| Symmetric windows (both 20) | Demotion would be too slow; a struggling user would suffer 20 demoralising attempts before receiving easier content |
| Symmetric thresholds (both 0.75/0.40) | Already symmetric on the value axis; the chosen values reflect meaningful performance levels |
| Single threshold with hysteresis band | Equivalent to what is implemented; the 0.40–0.75 band is the hysteresis region |

### 9.4 Offline Median Computation vs. Online Approximation

| Approach | Pros | Cons |
|---|---|---|
| **Scheduled offline scan (chosen)** | Accurate; simple logic | 24-hour lag; DynamoDB Scan cost scales with data volume |
| Online reservoir sampling | O(1) memory; continuously updated | Requires stateful infrastructure (e.g. a Kinesis stream + DynamoDB Streams consumer); overkill for v1 |
| Client-reported timing only, no median | No infrastructure required | Easily gamed; no calibration |

Scheduled offline scan chosen for v1. Migration path to stream-based incremental at scale is documented here for future reference.

### 9.5 Single-Table vs. Multi-Table DynamoDB Design

The HLD specified single-table design (Users table holds both PROFILE and ATTEMPT items under the same partition key). This enables efficient retrieval of all data for a user in a single Query. The alternative (separate Attempts table) would require cross-table joins in the Lambda, which DynamoDB does not support natively.

### 9.6 Per-Attempt Speed Score vs. Window-Level Speed Comparison

An alternative would compare the user's mean time over the window against the per-difficulty median (one comparison per window rather than per attempt). The chosen per-attempt approach was selected because:
- It handles windows that span a tier transition more cleanly (each attempt is scored against the median for the tier it was taken at)
- It is symmetric with the correct-rate calculation (both are means over per-attempt values)

---

## 10. Edge Case Probe

The following questions identify gaps, unstated assumptions, or failure modes in this LLD that require product or engineering decisions before implementation.

1. **What happens if a user submits a `timeTakenMs` value that is technically valid (> 0) but suspiciously large (e.g. 9 hours), bypassing the 10-minute exclusion applied only in the offline median script?** The attempt is recorded, `rawSpeed` approaches zero, and `speedScore` approaches 0 — effectively penalising the user's composite score. Is this the intended behaviour, or should the Lambda also cap `timeTakenMs` before recording?

2. **What happens if the `SPEED_MEDIANS` config item does not exist in DynamoDB (e.g. deployment error or first ever deploy)?** The Lambda would throw a NullPointerException/AttributeError when reading medians. Should the Lambda fall back to the neutral 0.5 default, or should it fail the request with a 500?

3. **What happens when the ComputeMedians Lambda fails silently (e.g. DynamoDB Scan times out partway through)?** The `SPEED_MEDIANS` item would contain stale or partially-computed values. There is no alerting defined in this LLD. Who monitors `computedAt` staleness?

4. **Is the 100-attempt threshold for "established median" per-tier or global?** This LLD states per-tier, but ADVANCED may never reach 100 if the platform has few users who reach that tier. Should there be a fallback (e.g. use INTERMEDIATE median for ADVANCED when ADVANCED is unestablished)?

5. **What happens if a user's Cognito account is deleted and recreated (e.g. support reset)?** The new Cognito sub will not match the old PK; the user starts fresh at BEGINNER. Is there a migration path to preserve history?

6. **What happens when a user answers correctly but extremely slowly across all 20 window attempts?** With `correctRate = 1.0` and `speedScore ≈ 0`, composite ≈ `0.70 × 1.0 + 0.30 × 0` = 0.70. This is below the 0.75 tier-up threshold, meaning a user who answers everything correctly but slowly can never be promoted. Is this intended behaviour?

7. **What happens if a snippet is retired (removed from the Snippets table) after a user has answered it?** The attempt record references a `snippetId` that no longer exists. `GetProgress` and `SubmitAnswer` do not validate historical `snippetId` references, so this is benign for scoring. But should retired snippets be soft-deleted (flagged `active = false`) rather than hard-deleted to preserve referential integrity?

8. **What happens if two `SubmitAnswer` calls arrive concurrently for the same user (e.g. tab duplication)?** The conditional UpdateItem guards the PROFILE update, but both attempt records will be written. The window query on the next call will see both. Is there a deduplication requirement, or is recording both attempts acceptable?

9. **How is the tier displayed to the user when they are mid-window (not yet eligible for promotion)?** The API returns `currentTier` and `compositeScore`, but not "you need X more qualifying attempts". Should the LLD specify a `attemptsUntilEvaluation` field in the response?

10. **Is there a minimum number of attempts before a tier-down can fire?** This LLD says tier-down requires exactly 10 window attempts at the current tier. A user who was manually assigned to INTERMEDIATE (e.g. via a support tool) could be demoted after only 10 attempts. Is manual tier assignment in scope, and if so does it reset the transition timestamp?

11. **What happens if the EventBridge rule for the ComputeMedians Lambda is accidentally disabled?** Medians go stale indefinitely. Speed scores become misleading. There is no circuit-breaker defined. Should the Lambda emit a CloudWatch metric on each publish of `SPEED_MEDIANS` so an alarm can detect missed refreshes?

12. **What tier is used for speed score normalisation when an attempt is submitted at INTERMEDIATE but the user's window contains a mix of BEGINNER and INTERMEDIATE attempts (post-promotion, window not yet full)?** This LLD filters the window by `tierId = currentTier`, so only INTERMEDIATE attempts are included. The scoring window will contain fewer than 20 items. Is the product team comfortable that the first attempt at a new tier cannot trigger any transition (correct, since |W| = 1)?
