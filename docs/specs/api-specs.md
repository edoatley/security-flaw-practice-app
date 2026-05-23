# API Validation & Security Rules — EARS Specifications

**Version:** 0.1 (Draft)
**Status:** Under Review
**Date:** 2026-05-16
**Source Documents:**
- [`docs/llds/api.md`](../llds/api.md) v0.1
- [`docs/llds/data-model.md`](../llds/data-model.md) v0.1

**Status key:** `[ ]` active, `[x]` implemented, `[D]` deferred

---

## Table of Contents

1. [Authentication & Authorization](#1-authentication--authorization)
2. [Sensitive Field Redaction](#2-sensitive-field-redaction)
3. [GetSnippet — User Profile Lifecycle](#3-getsnippet--user-profile-lifecycle)
4. [GetSnippet — Snippet Selection](#4-getsnippet--snippet-selection)
5. [SubmitAnswer — Input Validation](#5-submitanswer--input-validation)
6. [SubmitAnswer — Answer Evaluation](#6-submitanswer--answer-evaluation)
7. [SubmitAnswer — Response Content](#7-submitanswer--response-content)
8. [SubmitAnswer — Time Recording](#8-submitanswer--time-recording)
9. [SubmitAnswer — Persistence](#9-submitanswer--persistence)
10. [GetProgress — Response Content](#10-getprogress--response-content)
11. [Error Response Envelope](#11-error-response-envelope)
12. [Observability](#12-observability)
13. [Consistency Report](#13-consistency-report)

---

## 1. Authentication & Authorization

### API-001 [x]

When an HTTP request arrives at any API Gateway v2 route without an `Authorization: Bearer <jwt>` header, the API Gateway JWT authorizer shall reject the request with HTTP 401 without invoking the target Lambda function.

**Source:** api.md §2.1
**Rationale:** The Lambda must never be executed on unauthenticated requests; rejection must be enforced at the gateway layer.

---

### API-002 [x]

When an HTTP request arrives at any API Gateway v2 route with a malformed, expired, or otherwise invalid JWT in the `Authorization: Bearer <jwt>` header, the API Gateway JWT authorizer shall reject the request with HTTP 401 without invoking the target Lambda function.

**Source:** api.md §2.1
**Rationale:** Invalid tokens must be indistinguishable from absent tokens at the infrastructure layer; neither must reach Lambda execution.

---

### API-003 [x]

The `GetSnippet`, `SubmitAnswer`, and `GetProgress` Lambda functions shall each extract the canonical `userId` exclusively from the `requestContext.authorizer.jwt.claims.sub` path of the verified API Gateway event, and shall not perform independent JWT signature verification.

**Source:** api.md §2.1
**Rationale:** Verification is fully delegated to the authorizer; re-verification in Lambda would be redundant and could diverge from authorizer logic.

---

### API-004 [ ]

If the `sub` claim is absent from the authorizer context that reaches a Lambda function, the Lambda shall throw an internal error and return HTTP 500, treating the condition as an unexpected infrastructure misconfiguration rather than a user-facing 4xx.

**Source:** api.md §2.1 (code snippet — `throw new Error("sub claim missing from authorizer context")`)
**Rationale:** A missing `sub` after a valid authorizer pass indicates a configuration defect, not a user error.

---

## 2. Sensitive Field Redaction

### API-005 [x]

The `GetSnippet` Lambda shall never include the `vulnerableLines` attribute in any HTTP response it returns, regardless of what is stored in DynamoDB for the queried snippet.

**Source:** api.md §2.3 (field notes), §3.4 Step 2; data-model.md §2.1, §5 AP-4
**Rationale:** Exposing the answer key before submission defeats the educational purpose of the platform.

---

### API-006 [x]

The `GetSnippet` Lambda shall never include the `explanation` attribute in any HTTP response it returns, regardless of what is stored in DynamoDB for the queried snippet.

**Source:** api.md §2.3 (field notes), §3.4 Step 2; data-model.md §2.1, §5 AP-4
**Rationale:** The explanation is post-submission feedback only; returning it beforehand reveals vulnerability context.

---

### API-007 [x]

While constructing a `GET /api/snippet` 200 response, the `GetSnippet` Lambda shall include the `vulnerableLineCount` field (the count of vulnerable lines) and shall not derive or reconstruct the actual line numbers from any other returned field.

**Source:** api.md §3.3 (response contract field notes)
**Rationale:** The client needs to know how many lines to select without learning which lines they are.

---

### API-008 [x]

The `GetProgress` Lambda shall omit the `submittedLines` attribute from every item in the `recentAttempts` array it returns, even though `submittedLines` is stored on each attempt record in DynamoDB.

**Source:** api.md §5.3 (field notes on `recentAttempts`)
**Rationale:** Returning stored submitted lines for non-reviewed attempts could hint at correct answers for snippets the user encounters again.

---

## 3. GetSnippet — User Profile Lifecycle

### API-009 [x]

When the `GetSnippet` Lambda performs a strongly consistent `GetItem` for a user profile and receives a definitive miss (item does not exist), the Lambda shall treat the request as the user's first visit and shall proceed to create a new profile with `currentTier` set to `BEGINNER`.

**Source:** api.md §3.4 Step 1; data-model.md §2.2
**Rationale:** Profile creation is lazy — it occurs at first use rather than at Cognito registration.

---

### API-010 [x]

When creating a new user profile on first visit, the `GetSnippet` Lambda shall issue the `PutItem` call with a `ConditionExpression` of `attribute_not_exists(PK)` so that a concurrent first-visit request from the same user cannot create a duplicate profile record.

**Source:** api.md §3.4 Step 1; data-model.md §5 AP-2
**Rationale:** Without the condition guard, a race between two simultaneous first requests could write two profile items or corrupt the initial state.

---

### API-011 [x]

If the conditional `PutItem` for new profile creation fails because a concurrent request already created the profile (DynamoDB returns `ConditionalCheckFailedException`), the `GetSnippet` Lambda shall immediately retry the `GetItem` using a strongly consistent read to obtain the profile created by the concurrent request, rather than returning an error to the caller.

**Source:** api.md §3.4 Step 1
**Rationale:** The condition failure means a valid profile now exists; a retry read recovers gracefully without surfacing the race to the user.

---

### API-012 [x]

If the conditional `PutItem` for new profile creation fails and any subsequent error prevents the Lambda from obtaining a valid user profile, the `GetSnippet` Lambda shall return HTTP 500 with error code `PROFILE_INIT_FAILED`.

**Source:** api.md §3.3 (error table)
**Rationale:** Profile initialisation failure is an unrecoverable server-side fault for this request.

---

## 4. GetSnippet — Snippet Selection

### API-013 [x]

When zero snippet records exist in DynamoDB for the user's current tier (i.e. the GSI query on `DIFFICULTY#<tier>` returns an empty result set before any exclusion filtering), the `GetSnippet` Lambda shall return HTTP 200 with a body of `{ "status": "TIER_COMPLETE", "tier": "<tier>", "canReset": true }` and shall not return HTTP 404.

**Source:** api.md §3.4 Step 4
**Rationale:** An empty tier is a valid game state (all snippets completed), not a missing-resource error; HTTP 404 would prevent the client from distinguishing this from a misconfiguration.

---

### API-014 [x]

When selecting a snippet, the `GetSnippet` Lambda shall query the most recent 5 attempt records for the authenticated user and shall exclude their corresponding `snippetId` values from the candidate set before making a random selection.

**Source:** api.md §3.4 Step 3
**Rationale:** Excluding recently seen snippets prevents the platform from immediately repeating the same exercise.

---

### API-015 [x]

If excluding the recently-seen snippet IDs from the candidate set results in an empty set, the `GetSnippet` Lambda shall fall back to the full (unfiltered) candidate set and shall still return a snippet rather than an error response.

**Source:** api.md §3.4 Step 3
**Rationale:** When a tier has very few snippets (e.g. 5 or fewer), exclusion must not cause an artificial dead-end; TIER_COMPLETE applies only when the tier is genuinely empty.

---

### API-016 [x]

The `GetSnippet` Lambda shall query snippets from the GSI with a `ProjectionExpression` that explicitly omits `vulnerableLines` and `explanation`, ensuring those attributes are not loaded into Lambda memory during snippet selection.

**Source:** api.md §3.4 Step 2
**Rationale:** Defence-in-depth — redaction at the projection layer prevents accidental exposure even if the response-assembly code is changed.

---

## 5. SubmitAnswer — Input Validation

### API-017 [x]

The `SubmitAnswer` Lambda shall validate that every element of the `selectedLines` array is an integer with a value of 1 or greater, and shall return HTTP 400 with error code `INVALID_LINE_NUMBER` (including the offending value in the error message) if any element fails this check.

**Source:** api.md §4.2 (field constraints), §4.3 (error table); data-model.md §7.2
**Rationale:** Line numbers are 1-indexed; zero or negative values are nonsensical and must be rejected before any DynamoDB access.

---

### API-018 [x]

The `SubmitAnswer` Lambda shall validate that every element of the `selectedLines` array is a whole integer (not a floating-point number), and shall return HTTP 400 with error code `INVALID_LINE_NUMBER` if any element is non-integer.

**Source:** api.md §4.2 (field constraints table — "positive integers")
**Rationale:** Fractional line numbers have no meaning in the context of source code lines.

---

### API-019 [x]

If `selectedLines` contains more elements than the snippet's `vulnerableLineCount` (fetched from DynamoDB), the `SubmitAnswer` Lambda shall return HTTP 400 with error code `TOO_MANY_LINES`.

**Source:** api.md §4.2, §4.3 (error table), §4.4 Step 3; data-model.md §7.2
**Rationale:** The client is already told the number of lines to select; exceeding it indicates a tampered or malformed request.

---

### API-020 [x]

If any element of `selectedLines` is greater than the snippet's `lineCount` (fetched from DynamoDB), the `SubmitAnswer` Lambda shall return HTTP 400 with error code `LINE_OUT_OF_RANGE`.

**Source:** api.md §4.3 (error table), §4.4 Step 3
**Rationale:** A line number beyond the file's total line count cannot correspond to any real source line.

---

### API-021 [x]

The `SubmitAnswer` Lambda shall perform all field-level validations that do not require a DynamoDB read (type checks, UUID format, array element types, `timeTakenMs` range) before issuing any DynamoDB operation, returning HTTP 400 immediately on the first violation found.

**Source:** api.md §4.4 Step 1
**Rationale:** Eager pre-fetch validation avoids wasting read capacity units on requests that are structurally invalid.

---

### API-022 [x]

When `SubmitAnswer` receives a request where `selectedLines` is absent, not an array, or is an empty array, the Lambda shall return HTTP 400 with error code `INVALID_SELECTED_LINES`.

**Source:** api.md §4.3 (error table)
**Rationale:** A non-empty array of selected lines is always required; there is no valid submission without at least one line selected.

---

## 6. SubmitAnswer — Answer Evaluation

### API-023 [x]

The `SubmitAnswer` Lambda shall evaluate correctness by testing exact set equality between the submitted line numbers and the stored `vulnerableLines` set, such that the submission is correct if and only if both sets contain identical elements regardless of the order in which they were submitted.

**Source:** api.md §4.4 Step 4, §D3; data-model.md §7.3
**Rationale:** Order-independence reflects the fact that the user is identifying a set of lines, not sequencing them; exact match with no partial credit is a deliberate v1 product decision.

---

### API-024 [x]

The `SubmitAnswer` Lambda shall record an attempt as `correct = false` whenever `selectedLines` does not exactly match `vulnerableLines` in set membership, including cases where the user correctly identifies a subset but misses one or more vulnerable lines.

**Source:** api.md §4.4 Step 4, §D3; data-model.md §7.3
**Rationale:** Partial credit is not awarded in v1; any mismatch, whether over- or under-selection, is treated as an incorrect answer.

---

## 7. SubmitAnswer — Response Content

### API-025 [x]

The `SubmitAnswer` Lambda shall include the snippet's `vulnerableLines` array and `explanation` string in the HTTP 200 response only when `correct` is `true`. When `correct` is `false`, the `snippet` object shall be omitted from the response entirely. This is the only route and condition under which these fields are returned to the client.

**Source:** api.md §4.3 (updated), §4.4 Step 9; product decision 2026-05-16
**Rationale:** Withholding the explanation on an incorrect answer preserves the learning incentive — the user must try again or skip to see why they were wrong.

---

### API-026 [x]

If the attempt submission results in a duplicate-detection failure (HTTP 409), the `SubmitAnswer` Lambda shall not return `vulnerableLines` or `explanation` in the error response body.

**Source:** api.md §2.2, §6.2 (409 ALREADY_SUBMITTED described as an error response using the standard envelope)
**Rationale:** The 409 path uses the standard error envelope, not the success response body; sensitive fields must not leak through error paths.

---

## 8. SubmitAnswer — Time Recording

### API-027 [x]

The `SubmitAnswer` Lambda shall clamp the client-supplied `timeTakenMs` value to a maximum of 600,000 milliseconds (10 minutes) before persisting the attempt record, discarding any client-supplied value above this ceiling.

**Source:** api.md §4.2 (field constraints), §4.4 Step 1, §D6
**Note:** See Consistency Report (§13) regarding a discrepancy with data-model.md §7.2, which states a cap of 3,600,000 ms.

---

### API-028 [ ]

The `SubmitAnswer` Lambda shall clamp `timeTakenMs` to a minimum of 0 milliseconds, treating any client-supplied negative value as 0 before persisting.

**Source:** api.md §4.2 (field constraints — "min 0"); data-model.md §7.2
**Rationale:** Negative durations are physically impossible; clamping to zero preserves a valid stored value without rejecting the submission.

---

### API-029 [x]

The `SubmitAnswer` Lambda shall use the clamped value of `timeTakenMs` — not the raw client-supplied value — when persisting the attempt record and when computing the speed score component of the composite score.

**Source:** api.md §4.4 Step 1, §D6
**Rationale:** Persisting the unclamped value would allow a client to skew per-tier speed medians by reporting extreme durations.

---

## 9. SubmitAnswer — Persistence

### API-030 [x]

The `SubmitAnswer` Lambda shall write the new attempt record and update the user profile counters atomically using a single `TransactWriteItems` call, so that neither write can succeed independently if the other fails.

**Source:** api.md §4.4 Step 8, §D4
**Rationale:** Without atomicity, a crash between writes could leave `totalAttempts` inconsistent with the number of attempt records, corrupting scoring and tier evaluation.

---

### API-031 [x]

The `TransactWriteItems` call in `SubmitAnswer` shall include a `ConditionExpression` of `attribute_not_exists(PK) AND attribute_not_exists(SK)` on the attempt `Put` operation so that a duplicate submission for the same user, snippet, and timestamp is rejected at the database level.

**Source:** api.md §6.2
**Rationale:** The condition guard makes duplicate detection server-enforced and atomic rather than relying on application-level de-duplication.

---

### API-032 [x]

When the `TransactWriteItems` call in `SubmitAnswer` fails with `TransactionCanceledException` due to a `ConditionalCheckFailed` reason on the attempt record, the Lambda shall return HTTP 409 with error code `ALREADY_SUBMITTED`.

**Source:** api.md §6.2
**Rationale:** A 409 gives the client a distinct, actionable signal that distinguishes a duplicate submission from any other server-side failure.

---

### API-033 [x]

The `SubmitAnswer` Lambda shall update the user profile's `currentTier`, `totalAttempts`, `updatedAt` fields, and (if the attempt was correct) `correctAttempts` within the same `TransactWriteItems` call as the attempt record write, so that profile state is always consistent with attempt history.

**Source:** api.md §4.4 Step 8
**Rationale:** Separating the profile update from the attempt write would create a window where counters are stale or tier state is wrong.

---

## 10. GetProgress — Response Content

### API-034 [x]

The `GetProgress` Lambda shall include `currentTier`, `totalAttempts`, `correctAttempts`, and the rolling-window composite score (as the `rolling` object containing at minimum `correctRate`, `speedScore`, `compositeScore`, and `windowSize`) in every HTTP 200 response.

**Source:** api.md §5.3 (response contract)
**Rationale:** These four top-level dimensions represent the full picture of user progress required by the frontend progress dashboard.

---

### API-035 [x]

When a request is made to `GET /api/progress` for a user whose profile does not exist in DynamoDB, the `GetProgress` Lambda shall return HTTP 404 with error code `USER_NOT_FOUND`.

**Source:** api.md §5.3 (error table)
**Rationale:** A user who has never called `GetSnippet` has no profile; this is a valid but distinct state that must be communicated to the client so it can prompt the user to play their first round.

---

## 11. Error Response Envelope

### API-036 [x]

The `GetSnippet`, `SubmitAnswer`, and `GetProgress` Lambda functions shall return all Lambda-originated error responses (4xx and 5xx) using the JSON envelope `{ "error": { "code": "<SNAKE_CASE_CODE>", "message": "<human-readable description>" } }` with no additional top-level fields.

**Source:** api.md §2.2
**Rationale:** A single consistent error shape across all routes allows the client to use a single error-handling path.

---

### API-037 [x]

The `GetSnippet`, `SubmitAnswer`, and `GetProgress` Lambda functions shall not wrap API Gateway-originated error responses (such as the JWT authorizer's 401) in the Lambda error envelope, as these are generated by API Gateway before Lambda is invoked.

**Source:** api.md §2.2
**Rationale:** API Gateway formats its own 401 responses natively; attempting to reformat them from Lambda is not possible and would create a false expectation in client code.

---

### API-038 [ ]

When a Lambda function encounters an unexpected internal exception, it shall return HTTP 500 with error code `INTERNAL_ERROR` and shall include the `correlationId` in the response body, but shall not include a stack trace or internal error detail in the response.

**Source:** api.md §6.1; error tables in §3.3, §4.3, §5.3
**Rationale:** Stack traces in error responses are an information-disclosure risk; the correlation ID enables debugging without surfacing internals.

---

### API-039 [ ]

When a Lambda function experiences a DynamoDB connectivity failure, it shall return HTTP 500 with error code `DYNAMO_ERROR` and shall log the failure with the `correlationId` for operational tracing.

**Source:** api.md §3.3, §4.3, §5.3 (error tables)
**Rationale:** Infrastructure failures must be surfaced as 5xx and associated with a traceable identifier so they can be distinguished from application-level bugs.

---

## 12. Observability

### API-040 [D]

Each of the `GetSnippet`, `SubmitAnswer`, and `GetProgress` Lambda functions shall generate a UUID `correlationId` at handler entry and shall include that value in every structured log line emitted during the invocation.

**Source:** api.md §6.1
**Rationale:** Without a per-invocation correlation ID, log lines from concurrent Lambda executions cannot be grouped and are not usable for request-level debugging.

---

### API-041 [D]

Each Lambda function shall include the authenticated `userId` (derived from the `sub` claim) in every structured log line it emits.

**Source:** api.md §6.1 (key fields: `correlationId`, `userId`, `duration`, `message`)
**Rationale:** User-scoped logging enables support investigation of per-user issues and security audit of data access patterns.

---

### API-042 [D]

Each Lambda function shall record the total handler duration in milliseconds and emit it as a structured log field named `duration` at the end of every invocation.

**Source:** api.md §6.1
**Rationale:** Duration is the primary operational metric for latency monitoring and is required for Lambda Power Tuning and cold-start analysis.

---

### API-043 [D]

Each Lambda function shall emit all log output as newline-delimited JSON objects (structured logging) rather than plain-text strings, to enable CloudWatch Logs Insights to query by field.

**Source:** api.md §6.1 (`console.log(JSON.stringify({...}))`)
**Rationale:** Structured JSON logs are a prerequisite for field-level filtering and aggregation in CloudWatch Logs Insights.

---

## 13. Consistency Report

This section documents gaps, contradictions, and implicit scoping issues identified by cross-referencing `api.md` and `data-model.md` during specification authoring. Each item is a candidate for a follow-up decision or document correction.

---

### 13.1 Contradictions

**C1 — `timeTakenMs` maximum cap (HIGH)**

`api.md` §4.2 specifies a maximum of **600,000 ms (10 minutes)** for `timeTakenMs`, and §D6 explicitly rationale-documents this choice. `data-model.md` §7.2 specifies a constraint of **3,600,000 ms (1 hour)**. These values are directly contradictory. API-027 defers to `api.md` as the authoritative source because §D6 provides explicit rationale, but the data model must be corrected to match. Until this is resolved, the loader script and SubmitAnswer Lambda may apply different caps.

**C2 — Attempt SK format: `<timestamp>#<attemptId>` vs `<timestamp>#<snippetId>`**

`api.md` §6.2 states the SK is `ATTEMPT#<ISO-8601>#<snippetId>` (snippet ID suffix) and uses this as the basis for the duplicate-detection condition expression. `api.md` §2.3 (attempt entity table) describes the SK as `ATTEMPT#<ISO8601Timestamp>#<attemptId>` (attempt ID suffix), and the `TransactWriteItems` code sample in §4.4 Step 8 also uses `<attemptId>`. These are materially different: using `<snippetId>` means a user can only submit one answer per snippet per millisecond (enabling effective deduplication); using `<attemptId>` means every request gets a fresh UUID SK and the condition check on the SK can never detect a true duplicate. The data-model.md §3 table also uses `<snippetId>` as the suffix. The duplicate-detection logic in §6.2 only works if the SK suffix is `<snippetId>`, but the code in §4.4 uses `<attemptId>`. This contradiction must be resolved before implementation; API-031 is written against the §6.2 intent (snippetId suffix) since that is the only variant that achieves idempotency.

---

### 13.2 Coverage Gaps

**G1 — `timeTakenMs` validation: rejection vs. clamping**

Both source documents state that `timeTakenMs` must be a non-negative integer but describe the out-of-range behaviour differently: the field constraint table in api.md §4.3 lists `INVALID_TIME_TAKEN` for a value that is not a non-negative integer, while the clamping logic in §4.4 Step 1 clamps values above 600,000 rather than rejecting them. It is not specified whether a value of, say, 700,000 results in a 400 error or is silently clamped. API-027 and API-028 implement clamping as described in the logic walkthrough, but an explicit decision on the exact validation/clamping boundary is missing from the design documents.

**G2 — `selectedLines` duplicate values**

Neither source document specifies whether the Lambda should reject a `selectedLines` array containing duplicate values (e.g., `[5, 5, 7]`). The set-equality check in data-model.md §7.3 would silently deduplicate duplicates, potentially allowing a user to submit fewer distinct identifications than intended. No spec covers this; a decision is needed (reject with `INVALID_SELECTED_LINES` or silently deduplicate), and a spec should be added.

**G3 — `snippetId` format validation in SubmitAnswer**

API-021 covers the UUID format check for `snippetId` at the pre-fetch validation stage, but no spec explicitly covers the error code (`INVALID_SNIPPET_ID`) returned when the format is invalid. The error table in api.md §4.3 provides this, but it is not captured as a standalone EARS requirement. A complementary spec to API-021 should be added.

**G4 — GetProgress response for a user with zero attempts**

No spec covers what `GetProgress` returns in the `rolling` object when a user exists (profile found) but has made zero attempts. Division-by-zero in correctRate and rollingSpeedScore computations must be handled, and the expected field values (e.g., `windowSize: 0`, `correctRate: null`) are not defined in either source document.

**G5 — Tier promotion/demotion boundary conditions**

api.md §4.4 Steps 6–7 define tier transition thresholds (`compositeScore >= 0.75` for upgrade, `< 0.40` for downgrade) but do not specify the `== 0.75` and `== 0.40` boundary cases as explicit business rules. The LLD notes this in §8.4 item 15 as an open question. No EARS spec covers these boundary conditions.

**G6 — TIER_COMPLETE vs. post-exclusion empty set**

API-013 covers the TIER_COMPLETE path (zero snippets in tier before exclusion) and API-015 covers the fall-back path (empty set after exclusion). However, no spec covers the observable difference between these two states from the client's perspective — specifically, that TIER_COMPLETE returns a structured status object while the fall-back returns a normal snippet. If the exclusion logic is ever incorrectly placed before the zero-check, TIER_COMPLETE would never trigger. A process-order constraint spec would make this testable.

---

### 13.3 Implicit Scoping Issues

**S1 — Lambda error envelope does not apply to 401**

API-037 clarifies that the error envelope does not apply to gateway-originated 401s, but this is an implicit caveat buried in the prose of api.md §2.2 rather than a standalone statement in the error tables. Client teams relying solely on the error tables would incorrectly expect a `{ error: { code, message } }` response from a 401. The error tables in §3.3, §4.3, and §5.3 should be annotated to make this exception explicit.

**S2 — `vulnerableLines` in SubmitAnswer response**

api.md §4.3 notes "`vulnerableLines` and `explanation` are returned in the response because the attempt has been submitted." However, §5 AP-5 (data-model.md) states SubmitAnswer "returns only `explanation` and correctness in the response (not the raw `vulnerableLines` array, even after submission)." These are directly contradictory on whether `vulnerableLines` is returned after submission. API-025 follows api.md §4.3 (full success response contract), which is corroborated by the JSON example in §4.3. The data-model.md §5 AP-5 note appears to be an authoring error and should be corrected.

**S3 — GetSnippet GSI query: `Limit: 200` vs. random-UUID wrap-around**

api.md §3.4 Step 2 describes fetching up to 200 snippets from the GSI and doing a client-side random pick. data-model.md §4.1 describes a different mechanism: a random-UUID lower-bound query with `Limit=1` and a wrap-around fallback. These are mutually inconsistent selection strategies. Neither API-013 nor API-016 constrains the implementation to a specific algorithm, but any spec covering selection fairness or reproducibility would need to pick one. The discrepancy should be resolved in the LLD before implementation begins.

**S4 — `GetSnippet` strongly consistent profile read**

api.md §3.4 Step 1 specifies a strongly consistent `GetItem` for the user profile. api.md §3.5 (DynamoDB Operations Summary) confirms this. However, GetProgress §5.5 uses eventual consistency for the same profile read. The difference is intentional (GetSnippet needs to see a just-created profile; GetProgress is read-only dashboard data) but this is not stated explicitly as a deliberate divergence anywhere in the documents. A note in the LLD would prevent a future developer from "harmonising" the consistency levels incorrectly.
