# Low-Level Design: API Lambda Functions

**Version:** 1.0 (Implemented)
**Status:** Implemented
**Date:** 2026-05-16
**Parent HLD:** [High-Level Design v0.4](../high-level-design.md)

---

## 1. Scope

This document covers the low-level design for all six AWS Lambda functions that sit behind the API Gateway v2 HTTP API. It defines the precise request/response contracts, DynamoDB access patterns, scoring logic, cold start mitigations, and IAM permissions for each function. Frontend integration details and infrastructure-as-code specifics (SST resource declarations) are out of scope here.

The six functions are:

| Route | Function Name | Auth | Primary Concern |
|---|---|---|---|
| `GET /api/snippet` | `GetSnippet` | JWT required | Adaptive snippet selection; return metadata + CloudFront URL |
| `POST /api/answer` | `SubmitAnswer` | JWT required | Validate, score, persist attempt, re-evaluate tier |
| `GET /api/progress` | `GetProgress` | JWT required | Aggregate attempt history; return stats and current tier |
| `POST /auth/session` | `AuthSession` | None | Receive refresh token from SPA; set httpOnly cookie |
| `POST /auth/refresh` | `AuthRefresh` | None | Exchange cookie for new access token |
| `POST /auth/logout` | `AuthLogout` | None | Revoke refresh token; clear cookie |

Sections 3–5 cover the game functions (JWT-authorised). Section 6 covers cross-cutting concerns. **Section 7 covers the three auth functions** (no JWT authorizer). Section 8 covers decisions and alternatives.

---

## 2. Shared Conventions

### 2.1 Authentication Context

API Gateway v2 evaluates the `Authorization: Bearer <jwt>` header against the Cognito JWT authorizer before any Lambda is invoked. A missing or invalid token yields a `401` from API Gateway directly — the Lambda is never called.

The authorizer injects the verified claims into the Lambda event under `requestContext.authorizer.jwt.claims`. Every Lambda extracts the Cognito `sub` from this path as the canonical `userId`. No Lambda performs its own JWT verification.

```typescript
// Shared utility — inline in each handler or extracted to a shared module
function getUserId(event: APIGatewayProxyEventV2): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!sub) throw new Error("sub claim missing from authorizer context");
  return sub as string;
}
```

### 2.2 Error Response Envelope

All Lambda-originated error responses use a consistent JSON shape:

```json
{
  "error": {
    "code": "SNAKE_CASE_ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

API Gateway 4xx errors (e.g., the JWT authorizer returning 401) use API Gateway's native format, not this envelope. Lambdas do not need to handle authentication failures.

### 2.3 DynamoDB Table Design

A single DynamoDB table is used with overloaded partition and sort keys. The two logical entity types share this table:

**Snippets entity**

| Attribute | Type | Notes |
|---|---|---|
| `PK` | String | `SNIPPET#<snippetId>` |
| `SK` | String | `METADATA` |
| `snippetId` | String | UUID |
| `title` | String | Human-readable name |
| `language` | String | `java` at launch |
| `difficulty` | String | `BEGINNER` \| `INTERMEDIATE` \| `ADVANCED` |
| `owaspCategory` | String | e.g., `A03_INJECTION` — underscore-enum format; see data-model.md §7.1 for full list |
| `vulnerableLines` | Number Set | Correct line numbers (1-indexed) — never sent to client |
| `vulnerableLineCount` | Number | `vulnerableLines.size` — sent to client as the selection cap |
| `lineCount` | Number | Total lines in the snippet file |
| `explanation` | String | Plain-text or Markdown explanation — sent only after a **correct** submission |
| `contentKey` | String | S3 object key |
| `source` | String | Provenance note |
| `GSI1PK` | String | `DIFFICULTY#<difficulty>` |
| `GSI1SK` | String | `SNIPPET#<snippetId>` |

**GSI1** (`GSI1PK-GSI1SK-index`): partition key = `GSI1PK`, sort key = `GSI1SK`. Projects all attributes. Used by `GetSnippet` to query by difficulty. Note: `data-model.md` refers to this index by the logical alias `DIFFICULTY_INDEX`; the physical SST-assigned name is `GSI1PK-GSI1SK-index` and is the authoritative name used in code and IAM policies. Aligning these to a single canonical name is tracked as tech debt.

**User profile entity**

| Attribute | Type | Notes |
|---|---|---|
| `PK` | String | `USER#<userId>` |
| `SK` | String | `PROFILE` |
| `userId` | String | Cognito sub |
| `email` | String | From Cognito token; informational only, not used for auth |
| `currentTier` | String | `BEGINNER` \| `INTERMEDIATE` \| `ADVANCED` |
| `totalAttempts` | Number | Lifetime count |
| `correctAttempts` | Number | Lifetime count |
| `lastTransitionTimestamp` | String | ISO 8601 — timestamp of most recent tier promotion or demotion; used by rolling-window filter to exclude pre-transition attempts (see adaptive-difficulty.md §6.3) |
| `lastTransitionType` | String | `PROMOTION` \| `DEMOTION` — type of most recent transition; absent until first transition |
| `createdAt` | String | ISO 8601 |
| `updatedAt` | String | ISO 8601 |

**Attempt entity** (one item per attempt, co-located in same table)

| Attribute | Type | Notes |
|---|---|---|
| `PK` | String | `USER#<userId>` |
| `SK` | String | `ATTEMPT#<ISO8601Timestamp>#<snippetId>` |
| `snippetId` | String | |
| `correct` | Boolean | |
| `submittedLines` | Number Set | Lines the user selected |
| `timeTakenMs` | Number | Client-supplied; capped server-side |
| `tierId` | String | Tier active at time of attempt |
| `timestamp` | String | ISO 8601 |

The lexicographic sort key format `ATTEMPT#<ISO8601>#<uuid>` means a `Query` with `ScanIndexForward: false` naturally returns the most recent attempts first, which is needed for the rolling window computation.

**Config entity** (holds speed-score medians; updated by an offline process)

| Attribute | Type | Notes |
|---|---|---|
| `PK` | String | `CONFIG#SPEED_MEDIANS` |
| `SK` | String | `V0` (version sentinel; see data-model.md §2.4) |
| `medians` | Map | `{ BEGINNER: number, INTERMEDIATE: number, ADVANCED: number }` — ms |
| `updatedAt` | String | ISO 8601 |

### 2.4 Lambda Runtime Defaults

Unless overridden per function, all three Lambdas share:

- **Runtime:** Node.js 22.x
- **Architecture:** arm64 (Graviton2 — lower cost, comparable performance)
- **Bundler:** esbuild via SST (tree-shaken; `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` externalized to the Lambda runtime layer only if version pinning requires it; otherwise bundled)
- **Environment variables:** `TABLE_NAME`, `CLOUDFRONT_DOMAIN`, `CONTENT_BUCKET_NAME`

---

## 3. GetSnippet Lambda

### 3.1 Trigger

`GET /api/snippet`

No query parameters are required. API Gateway passes a validated JWT; the Lambda reads the `sub` claim.

### 3.2 Request Contract

```
GET /api/snippet
Authorization: Bearer <cognito-jwt>
```

No request body. No query parameters (reserved for future filtering).

### 3.3 Response Contract

**200 OK — snippet selected**

```json
{
  "snippetId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "title": "SQL Injection via String Concatenation",
  "language": "java",
  "owaspCategory": "A03_INJECTION",
  "difficulty": "BEGINNER",
  "lineCount": 24,
  "vulnerableLineCount": 1,
  "contentUrl": "https://d1abc123.cloudfront.net/snippets/abc123.java",
  "expiresAt": null
}
```

Field notes:
- `contentUrl` is a CloudFront URL constructed as `https://<CLOUDFRONT_DOMAIN>/<contentKey>`. It is a stable public-ish URL (OAC enforces that only CloudFront can read the bucket), not a pre-signed URL. `expiresAt` is `null` to reflect this.
- `vulnerableLineCount` tells the client how many lines the user may select before submission is enabled. The actual vulnerable line numbers are never included.
- `lineCount` allows the frontend to render line numbers correctly and validate that submitted lines are in range (a secondary safeguard; the server also validates).

**Error responses**

| Scenario | HTTP Status | `error.code` | Notes |
|---|---|---|---|
| No profile found AND DynamoDB write fails | 500 | `PROFILE_INIT_FAILED` | Profile is normally lazily created |
| No snippets exist at the user's tier | 200 | — | Returns `{ "status": "TIER_COMPLETE", "tier": "<tier>", "canReset": true }` — see below |
| DynamoDB unreachable | 500 | `DYNAMO_ERROR` | Logged with correlation ID |
| Unexpected exception | 500 | `INTERNAL_ERROR` | Stack trace logged, not surfaced |

### 3.4 Logic Walkthrough

#### Step 1 — Resolve user tier

The Lambda issues a `GetItem` on `PK=USER#<userId>`, `SK=PROFILE`:

- **Profile found:** read `currentTier`.
- **Profile not found:** this is the user's first visit. The Lambda performs a `PutItem` (with `ConditionExpression: attribute_not_exists(PK)` to guard concurrent first calls) to create the profile with `currentTier=BEGINNER`, then uses `BEGINNER` for this request. If the conditional write fails due to concurrent creation (condition check failure), the Lambda retries the `GetItem` once to read the profile the concurrent request created.

The `GetItem` is a strongly consistent read so that a just-registered user who immediately hits this endpoint sees a definitive miss rather than a stale read.

#### Step 2 — Query snippets GSI by difficulty

```
KeyConditionExpression: GSI1PK = "DIFFICULTY#<currentTier>"
IndexName: GSI1PK-GSI1SK-index
ProjectionExpression: snippetId, contentKey, lineCount, vulnerableLineCount, title, language, owaspCategory, difficulty
```

Note: `vulnerableLines` and `explanation` are deliberately excluded from the projection to ensure they are never loaded into the Lambda's memory unnecessarily during snippet selection.

The query uses `Limit` dynamically: if fewer than 50 items are returned, all are kept. If the table grows large the query will paginate; to avoid multi-page scans, the Lambda issues the query with `Limit: 200` and does a client-side random pick from the result set. A future optimisation can use DynamoDB parallel scans with random seeds, but at expected snippet counts (< 500 per tier at launch) a single page query is fine.

#### Step 3 — Exclude recently seen snippets (best-effort)

To avoid showing the user the same snippet twice in quick succession, the Lambda issues a second DynamoDB query for the most recent 5 attempt records:

```
KeyConditionExpression: PK = "USER#<userId>" AND begins_with(SK, "ATTEMPT#")
ScanIndexForward: false
Limit: 5
ProjectionExpression: snippetId
```

The snippet IDs from these attempts are added to an exclusion set. If excluding them leaves no candidates (e.g., there are only 5 snippets in the tier), the exclusion is ignored and the full set is used rather than returning a 404.

#### Step 4 — Handle empty candidate set (TIER_COMPLETE)

If after the GSI query (and before exclusion filtering) **zero snippets exist for the user's current tier**, the Lambda returns HTTP 200 with a structured completion response rather than a 404:

```json
{
  "status": "TIER_COMPLETE",
  "tier": "ADVANCED",
  "canReset": true
}
```

The frontend interprets this response to:
- Display a "You've completed all snippets at this difficulty level" message
- Offer a **Reset Progress** button that calls `DELETE /api/progress/tier` (deferred — see HLD non-goals for reset route design)
- Grey out the completed tier indicator on the progress dashboard

This is distinct from the post-exclusion empty set case (only N snippets in tier and user has seen all N recently), which falls back to the full candidate set rather than returning `TIER_COMPLETE`.

#### Step 5 — Random selection

A cryptographically random index (`Math.floor(Math.random() * candidates.length)`) is used to pick one snippet from the remaining candidates. Standard `Math.random()` is acceptable here — the selection need not be cryptographically secure, just unpredictable enough to feel random.

#### Step 6 — Build CloudFront URL and respond

```typescript
const contentUrl = `https://${process.env.CLOUDFRONT_DOMAIN}/${snippet.contentKey}`;
```

The response object is assembled from the selected snippet's non-sensitive projection attributes plus the constructed URL, then returned with HTTP 200.

### 3.5 DynamoDB Operations Summary

| Operation | Type | Consistency | Notes |
|---|---|---|---|
| Read user profile | `GetItem` | Strong | Lazy-create on miss |
| Create user profile (first visit) | `PutItem` | Conditional | `attribute_not_exists(PK)` |
| Query snippets by tier | `Query` on GSI1 | Eventual | Projection excludes sensitive attributes |
| Query recent attempts | `Query` | Eventual | ScanIndexForward=false, Limit=5 |

### 3.6 Cold Start Considerations

- **Memory:** 512 MB. GetSnippet does 3–4 DynamoDB calls; it is network-bound, not CPU-bound. 512 MB gives adequate headroom without over-provisioning. Evaluate with AWS Lambda Power Tuning post-launch.
- **Bundling:** esbuild bundles only the AWS SDK v3 modular clients used (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`). The DynamoDB `DocumentClient` is constructed once outside the handler at module initialization so it is reused across warm invocations.
- **Provisioned Concurrency:** Not required at launch — acceptable cold start latency (~300–600 ms on arm64 with bundled SDK) for a game application. Reassess if P99 cold starts exceed 1 s after traffic ramps.

### 3.7 IAM Permissions (Least Privilege)

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query"
  ],
  "Resource": [
    "arn:aws:dynamodb:<region>:<account>:table/<TableName>",
    "arn:aws:dynamodb:<region>:<account>:table/<TableName>/index/GSI1PK-GSI1SK-index"
  ]
}
```

No S3 permissions are required — the Lambda constructs a CloudFront URL from stored metadata; it does not generate pre-signed URLs or read S3 directly.

---

## 4. SubmitAnswer Lambda

### 4.1 Trigger

`POST /api/answer`

### 4.2 Request Contract

```
POST /api/answer
Authorization: Bearer <cognito-jwt>
Content-Type: application/json

{
  "snippetId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "selectedLines": [7],
  "timeTakenMs": 34200
}
```

Field constraints:

| Field | Type | Constraints |
|---|---|---|
| `snippetId` | string | Required; UUID format |
| `selectedLines` | number[] | Required; non-empty array; elements must be positive integers; max length enforced against snippet's `vulnerableLineCount` |
| `timeTakenMs` | number | Required; integer; min 0; max 600000 (10 minutes — anything above is clamped to 600000 to prevent skewing speed scores) |

### 4.3 Response Contract

**200 OK — attempt recorded**

```json
{
  "attemptId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "correct": true,
  "score": {
    "rollingCorrectRate": 0.82,
    "rollingSpeedScore": 0.64,
    "compositeScore": 0.763,
    "windowSize": 20
  },
  "tierChange": {
    "previous": "BEGINNER",
    "current": "INTERMEDIATE",
    "changed": true
  },
  "snippet": {
    "vulnerableLines": [7],
    "owaspCategory": "A03_INJECTION",
    "explanation": "The query is built by concatenating user-supplied input directly into the SQL string on line 7. An attacker can inject arbitrary SQL..."
  }
}
```

Notes:
- `vulnerableLines` and `explanation` are returned **only when `correct` is `true`**. On an incorrect submission the `snippet` object is omitted — the user must try again (or skip) to see the answer. This is intentional: withholding the explanation on failure preserves the learning incentive. This is the only route and condition under which these fields are ever returned to the client.
- `tierChange.changed` is `false` when the tier did not change; `previous` and `current` will be equal in that case.
- `score` reflects the rolling window recomputed after this attempt is persisted.

**Error responses**

| Scenario | HTTP Status | `error.code` | Notes |
|---|---|---|---|
| Missing or malformed request body | 400 | `INVALID_REQUEST_BODY` | |
| `snippetId` missing or not a UUID | 400 | `INVALID_SNIPPET_ID` | |
| `selectedLines` is empty, missing, or not an array | 400 | `INVALID_SELECTED_LINES` | |
| Any element of `selectedLines` is not a positive integer | 400 | `INVALID_LINE_NUMBER` | Message includes the offending value |
| Any element of `selectedLines` exceeds the snippet's `lineCount` | 400 | `LINE_OUT_OF_RANGE` | Evaluated after snippet is fetched |
| `selectedLines.length > vulnerableLineCount` | 400 | `TOO_MANY_LINES` | Evaluated after snippet is fetched |
| `timeTakenMs` missing or not a non-negative integer | 400 | `INVALID_TIME_TAKEN` | |
| `snippetId` not found in DynamoDB | 404 | `SNIPPET_NOT_FOUND` | |
| User profile not found | 404 | `USER_NOT_FOUND` | Should not occur if GetSnippet was called first |
| DynamoDB unreachable | 500 | `DYNAMO_ERROR` | |
| Unexpected exception | 500 | `INTERNAL_ERROR` | |

### 4.4 Logic Walkthrough

#### Step 1 — Parse and preliminary validate

The Lambda parses the JSON body. All field-level validations (type checks, UUID format, array element types, `timeTakenMs` range) that can be done without a database call are performed synchronously before any DynamoDB I/O. Violations return 400 immediately.

`timeTakenMs` is clamped to 600000 after validation. The raw client value is not persisted uncapped.

#### Step 2 — Parallel DynamoDB reads

Two reads are issued concurrently with `Promise.all`:

1. **Fetch snippet metadata** — `GetItem` on `PK=SNIPPET#<snippetId>`, `SK=METADATA`. Reads `lineCount`, `vulnerableLineCount`, `vulnerableLines`, `owaspCategory`, `explanation`.
2. **Fetch user profile** — `GetItem` on `PK=USER#<userId>`, `SK=PROFILE`. Reads `currentTier`.

Both use strongly consistent reads to ensure correct state is seen even if writes by `GetSnippet` just completed.

If the snippet is not found, return 404 `SNIPPET_NOT_FOUND`. If the user profile is not found, return 404 `USER_NOT_FOUND`.

#### Step 3 — Post-fetch validation

With `lineCount` and `vulnerableLineCount` from the snippet:

- Verify each element of `selectedLines` is ≤ `lineCount`. If not, return 400 `LINE_OUT_OF_RANGE`.
- Verify `selectedLines.length <= vulnerableLineCount`. If not, return 400 `TOO_MANY_LINES`.

#### Step 4 — Score the attempt

Correctness is determined by set equality between `selectedLines` (sorted) and `vulnerableLines` (sorted). A partial match counts as **incorrect** — the user must identify all vulnerable lines exactly. This is a deliberate product decision: partial credit is not awarded in v1.

```typescript
const correct =
  selectedLines.length === vulnerableLines.length &&
  selectedLines.sort().every((line, i) => line === vulnerableLines.sort()[i]);
```

#### Step 5 — Read rolling window for tier evaluation

Query the last 20 attempt records (or all, if fewer than 20 exist):

```
KeyConditionExpression: PK = "USER#<userId>" AND begins_with(SK, "ATTEMPT#")
ScanIndexForward: false
Limit: 20
ProjectionExpression: correct, timeTakenMs, tierId, timestamp
```

Also fetch the speed medians config item:

```
GetItem: PK=CONFIG#SPEED_MEDIANS, SK=V0
```

This read is done concurrently with the rolling window query using `Promise.all`.

#### Step 6 — Compute composite score

The rolling window includes the new (not-yet-written) attempt, so the Lambda prepends the current result to the in-memory list before computing.

```
effectiveWindow = [currentAttempt, ...lastN].slice(0, 20)
windowSize = effectiveWindow.length
correctRate = countWhere(correct == true) / windowSize

// Speed score per attempt: normalise timeTakenMs against the tier's median
// speedScore ∈ [0, 1]; 0.5 = at median speed; 1.0 = twice as fast; 0 = twice as slow
speedScorePerAttempt(attempt, medians):
  median = medians[attempt.tierId]
  rawSpeed = median / attempt.timeTakenMs          // > 1 if faster, < 1 if slower
  return Math.min(2, Math.max(0, rawSpeed)) / 2    // capped at [0, 1]

rollingSpeedScore = mean(speedScorePerAttempt for each attempt in window)

compositeScore = (correctRate * 0.7) + (rollingSpeedScore * 0.3)
```

#### Step 7 — Evaluate tier transition

Using only the attempts in the effective window:

```
Upgrade check (BEGINNER→INTERMEDIATE or INTERMEDIATE→ADVANCED):
  if windowSize >= 20 AND all 20 attempts in window have compositeScore window ≥ 0.75
  → promote one tier

Downgrade check (ADVANCED→INTERMEDIATE or INTERMEDIATE→BEGINNER):
  if windowSize >= 10 AND all 10 most recent attempts have compositeScore window < 0.40
  → demote one tier
```

The tier transition logic uses the rolling-window composite score, not per-attempt composite. The implementation re-evaluates the window prefix iteratively:

1. Compute the composite score for the full window.
2. For upgrade: check if the window is exactly 20 and the score ≥ 0.75.
3. For downgrade: check if the last 10 items in the window all had a compositeScore < 0.40 per the 10-item sub-window.

If a tier change is triggered, the new tier is written to the profile in the same transaction as the attempt record (see Step 8).

#### Step 8 — Write attempt record and update profile (transactionally)

A DynamoDB `TransactWriteItems` call bundles:

1. **Put attempt record** — new item with `PK=USER#<userId>`, `SK=ATTEMPT#<ISO8601>#<snippetId>`. Using `snippetId` (not a random UUID) in the SK is what makes the idempotency condition work: a duplicate submission for the same snippet within the same millisecond will produce an identical SK, triggering the `attribute_not_exists` condition failure.
2. **Update user profile** — increment `totalAttempts` by 1; increment `correctAttempts` by 1 if correct; update `currentTier` if changed; update `updatedAt`.

Using `TransactWriteItems` ensures that if the profile update fails, the attempt record is not written, preventing a state where the attempt is counted twice on retry.

```typescript
{
  TransactItems: [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `ATTEMPT#${timestamp}#${snippetId}`,
          snippetId,
          correct,
          submittedLines: selectedLines,
          timeTakenMs: clampedTimeTaken,
          tierId: userProfile.currentTier,
          timestamp,
        }
      }
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
        UpdateExpression:
          "SET currentTier = :tier, updatedAt = :now, totalAttempts = totalAttempts + :one" +
          (correct ? ", correctAttempts = correctAttempts + :one" : ""),
        ExpressionAttributeValues: {
          ":tier": newTier,
          ":now": timestamp,
          ":one": 1,
        },
      }
    }
  ]
}
```

#### Step 9 — Construct and return response

The response includes the newly computed rolling scores and the tier change (if any). If `correct` is `true`, the snippet's `vulnerableLines` and `explanation` are also included — the first and only time these are sent to the client. If `correct` is `false`, the `snippet` object is omitted from the response.

### 4.5 DynamoDB Operations Summary

| Operation | Type | Consistency | Notes |
|---|---|---|---|
| Fetch snippet metadata | `GetItem` | Strong | Reads sensitive fields (`vulnerableLines`, `explanation`) |
| Fetch user profile | `GetItem` | Strong | Parallel with snippet fetch |
| Query rolling window | `Query` | Eventual | ScanIndexForward=false, Limit=20 |
| Fetch speed medians config | `GetItem` | Eventual | Parallel with rolling window query |
| Write attempt + update profile | `TransactWriteItems` | — | Atomic; 2 item operations |

Total: up to 5 DynamoDB operations, 2 of which are in parallel and the last two are in a second parallel batch.

### 4.6 Cold Start Considerations

- **Memory:** 1024 MB. SubmitAnswer is the most compute-intensive Lambda (rolling window computation, set comparison, multiple DynamoDB calls). More memory also reduces cold start duration for the larger code path.
- **Timeout:** 10 seconds. The DynamoDB transaction has a system-side timeout of a few seconds; 10 s total gives room for retries on transient errors.
- **SDK Client reuse:** `DynamoDBDocumentClient` instantiated once at module scope. The `TransactWriteItems` marshaller is configured once.

### 4.7 IAM Permissions (Least Privilege)

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:TransactWriteItems"
  ],
  "Resource": [
    "arn:aws:dynamodb:<region>:<account>:table/<TableName>"
  ]
}
```

No GSI access needed (queries are on the main table PK/SK). No S3 permissions needed.

**Note on row-level isolation:** DynamoDB IAM does not natively support row-level access control. The Lambda enforces user isolation in code by always using the JWT-derived `userId` as the PK prefix. A future enhancement could add a `LeadingKeys` condition on the IAM policy, but this requires all write operations to use the same partition key pattern, which is satisfied by this design.

---

## 5. GetProgress Lambda

### 5.1 Trigger

`GET /api/progress`

### 5.2 Request Contract

```
GET /api/progress
Authorization: Bearer <cognito-jwt>
```

No body. No query parameters.

### 5.3 Response Contract

**200 OK**

```json
{
  "userId": "abc123-cognito-sub",
  "currentTier": "INTERMEDIATE",
  "totalAttempts": 47,
  "correctAttempts": 31,
  "lifetimeCorrectRate": 0.660,
  "rolling": {
    "windowSize": 20,
    "correctRate": 0.82,
    "speedScore": 0.64,
    "compositeScore": 0.763,
    "attemptsUntilUpgrade": null,
    "attemptsUntilDowngrade": 3
  },
  "recentAttempts": [
    {
      "attemptId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "snippetId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "correct": true,
      "tierId": "INTERMEDIATE",
      "timestamp": "2026-05-16T10:23:44Z"
    }
  ]
}
```

Field notes:
- `recentAttempts` is capped at the last 10 for display purposes; it does not include `submittedLines` (to avoid leaking answer data for non-reviewed attempts) nor `timeTakenMs` (not user-facing at this level).
- `attemptsUntilUpgrade`: the number of additional consecutive high-scoring attempts needed to trigger a tier upgrade, or `null` if an upgrade is not currently achievable (e.g., user is already at `ADVANCED`, or the rolling score is not trending toward the threshold). This is a best-effort approximation based on current trajectory, not a guarantee.
- `attemptsUntilDowngrade`: similarly, estimated attempts until a downgrade is triggered, or `null` if not at risk.

**Error responses**

| Scenario | HTTP Status | `error.code` | Notes |
|---|---|---|---|
| User profile not found | 404 | `USER_NOT_FOUND` | User exists in Cognito but has never called GetSnippet |
| DynamoDB unreachable | 500 | `DYNAMO_ERROR` | |
| Unexpected exception | 500 | `INTERNAL_ERROR` | |

### 5.4 Logic Walkthrough

#### Step 1 — Fetch profile and attempt history in parallel

Two queries are issued concurrently:

1. **GetItem** for user profile (`PK=USER#<userId>`, `SK=PROFILE`). Eventual consistency is acceptable here — slight staleness does not cause incorrect behavior.
2. **Query** for the 20 most recent attempts:
   ```
   KeyConditionExpression: PK = "USER#<userId>" AND begins_with(SK, "ATTEMPT#")
   ScanIndexForward: false
   Limit: 20
   ProjectionExpression: attemptId, snippetId, correct, timeTakenMs, tierId, timestamp
   ```

Also fetch the speed medians config item in parallel with these two calls.

If the profile `GetItem` returns no item, return 404 `USER_NOT_FOUND`.

#### Step 2 — Compute rolling window stats

Using the same composite score formula as `SubmitAnswer` (see §4.4, Step 6), compute:

- `correctRate` — correct answers / window size
- `rollingSpeedScore` — mean normalised speed score across the window
- `compositeScore` — weighted composite

#### Step 3 — Estimate attempts until tier change

This is a heuristic for UX guidance, not a guarantee.

**Attempts until upgrade** (if tier < ADVANCED):
- If `compositeScore >= 0.75` for all items currently in the window and `windowSize == 20`, upgrade is already pending (will trigger on next SubmitAnswer). Set to `0`.
- Otherwise, if `compositeScore < 0.75`, estimate how many more at-or-above-0.75 single-attempt composite scores are needed to push the 20-item rolling window average above 0.75. This is a forward simulation: add hypothetical perfect-score attempts to the window and see when the threshold is crossed. Cap the estimate at 20 to avoid unrealistic projections.
- If the current tier is `ADVANCED`, set to `null`.

**Attempts until downgrade** (if tier > BEGINNER):
- Mirror logic: simulate how many sub-0.40 attempts would push the last 10 items' composite below the threshold.
- If tier is `BEGINNER`, set to `null`.

#### Step 4 — Assemble and return response

The `recentAttempts` slice uses the first 10 items from the already-queried 20-item window (most recent first). The `timeTakenMs` field is omitted from this projection. The `submittedLines` are omitted to avoid inadvertently hinting at correct answers for snippets the user has not yet reviewed.

### 5.5 DynamoDB Operations Summary

| Operation | Type | Consistency | Notes |
|---|---|---|---|
| Fetch user profile | `GetItem` | Eventual | |
| Query recent attempts | `Query` | Eventual | ScanIndexForward=false, Limit=20 |
| Fetch speed medians | `GetItem` | Eventual | Parallel with above two |

All three operations run in parallel via `Promise.all`.

### 5.6 Cold Start Considerations

- **Memory:** 512 MB. GetProgress is read-only and computation-light. Three parallel DynamoDB reads dominate latency; CPU is minimal.
- **Caching:** A future optimisation would add a short-lived (e.g., 30 s) write-through cache (ElastiCache or DynamoDB DAX) for the speed medians config item, since it changes infrequently. Not required at launch.

### 5.7 IAM Permissions (Least Privilege)

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:Query"
  ],
  "Resource": [
    "arn:aws:dynamodb:<region>:<account>:table/<TableName>"
  ]
}
```

---

## 6. Cross-Cutting Concerns

### 6.1 Logging and Correlation

Each Lambda generates a `correlationId` (UUID) at handler entry and includes it in all structured log output and error responses. The response body includes `correlationId` on 500 errors only (not 4xx), to aid support without leaking internal details. CloudWatch Logs Insights is used for querying by correlation ID.

Log format is JSON (using `console.log(JSON.stringify({...}))`) to enable structured querying. Key fields: `level`, `correlationId`, `userId`, `duration`, `message`.

### 6.2 Retry and Idempotency

- **GetSnippet** is idempotent by nature (read-heavy; the lazy profile creation uses a conditional `PutItem`).
- **SubmitAnswer** defends against double-submission server-side. Each attempt record uses a composite SK of `ATTEMPT#<ISO-8601>#<snippetId>`. A DynamoDB `ConditionExpression` of `attribute_not_exists(PK) AND attribute_not_exists(SK)` on the attempt `PutItem` within the `TransactWriteItems` call causes the transaction to fail with `TransactionCanceledException` (reason: `ConditionalCheckFailed`) if an attempt for the same user+snippet+timestamp already exists. Because timestamps have millisecond precision, a genuine double-click within the same millisecond is the only remaining race. The Lambda returns HTTP `409 ALREADY_SUBMITTED` in this case so the client can surface a clear message rather than silently swallowing the error. The client also disables the Submit button after the first successful response as a UX guard.
- **GetProgress** is read-only and idempotent.

### 6.3 Throttling and Rate Limiting

API Gateway v2 default account-level throttling applies (10,000 RPS burst, 5,000 RPS steady). Per-route throttling is not configured at launch. If abuse is detected (e.g., automated answer submission), a WAF WebACL can be attached to the API Gateway stage to rate-limit by IP or Cognito sub.

### 6.4 Lambda Execution Role Pattern in SST

Each Lambda function in SST v4 gets its own execution role. Permissions are attached to the role in the `sst.config.ts` using `link` or explicit `permissions` blocks. No shared execution role is used across functions, ensuring blast radius is minimized if one function's role is misconfigured.

---

## 7. Auth Lambda Functions

The three auth functions share no JWT authorizer — API Gateway routes them directly to Lambda. Their sole job is managing the httpOnly refresh-token cookie lifecycle. The Cognito `CognitoIdentityProviderClient` is the only AWS SDK dependency; DynamoDB is not used.

For the full PKCE/auth flow from the frontend perspective see `frontend.md` §3.

---

### 7.1 AuthSession (`POST /auth/session`)

**Trigger:** Called by the SPA immediately after the Cognito Hosted UI redirects back with an authorization code. The SPA has already exchanged the code for tokens client-side via the Cognito `/oauth2/token` endpoint; it sends the resulting refresh token to this Lambda to be stored in a server-side cookie.

#### Request Contract

```
POST /auth/session
Content-Type: application/json

{
  "refreshToken": "<cognito-refresh-token>"
}
```

#### Response Contract

**200 OK**

```json
{ "ok": true }
```

Sets the following response header:

```
Set-Cookie: refresh_token=<value>; HttpOnly; Secure; SameSite=None; Path=/auth; Max-Age=2592000
```

**Error responses**

| Scenario | HTTP Status | `error.code` | Notes |
|---|---|---|---|
| Body missing or not JSON | 400 | `INVALID_REQUEST_BODY` | |
| `refreshToken` missing or not a string | 400 | `INVALID_REFRESH_TOKEN` | |
| Unexpected exception | 500 | `INTERNAL_ERROR` | |

#### Cookie Attributes

| Attribute | Value | Rationale |
|---|---|---|
| `HttpOnly` | set | Prevents JS access; mitigates XSS token theft |
| `Secure` | set | Required for `SameSite=None`; enforces HTTPS-only |
| `SameSite=None` | set | Allows cross-origin cookie sending (SPA on `localhost:5173`, API on `execute-api.amazonaws.com` in dev) |
| `Path=/auth` | set | Cookie is only sent to `/auth/*` routes; not attached to `/api/*` calls |
| `Max-Age=2592000` | 30 days | Matches Cognito refresh token validity |

#### IAM Permissions

No AWS SDK calls are made beyond constructing the response. No IAM permissions beyond basic Lambda execution are required.

---

### 7.2 AuthRefresh (`POST /auth/refresh`)

**Trigger:** Called by the SPA to silently renew the access token. Can be triggered proactively (at `expires_in - 300` seconds) or reactively (on a 401 response from an API call).

#### Request Contract

```
POST /auth/refresh
Cookie: refresh_token=<value>
```

No request body.

#### Response Contract

**200 OK**

```json
{
  "access_token": "<cognito-access-token>",
  "expires_in": 3600
}
```

**Error responses**

| Scenario | HTTP Status | `error.code` | Notes |
|---|---|---|---|
| `refresh_token` cookie absent | 401 | `NO_REFRESH_COOKIE` | User must re-authenticate |
| Cognito rejects the refresh token (expired, revoked) | 401 | `REFRESH_FAILED` | User must re-authenticate |
| Cognito unreachable | 502 | `COGNITO_ERROR` | Transient; client should retry |
| Unexpected exception | 500 | `INTERNAL_ERROR` | |

#### Logic

1. Parse the `Cookie` header for `refresh_token`.
2. If absent → return 401 `NO_REFRESH_COOKIE`.
3. POST to `https://<COGNITO_DOMAIN>/oauth2/token` with `grant_type=refresh_token`, `client_id=<CLIENT_ID>`, `refresh_token=<value>`.
4. If Cognito returns an error → return 401 `REFRESH_FAILED`.
5. Return the new `access_token` and `expires_in` in the response body. Do **not** re-set the `refresh_token` cookie (Cognito may or may not rotate it; the SPA re-calls `AuthSession` only on the initial login).

#### IAM Permissions

No DynamoDB permissions. Outbound HTTPS to Cognito's token endpoint is made via the Node.js native `https` module (or the AWS SDK's Cognito client). No additional IAM permissions beyond Lambda execution are needed for outbound HTTPS calls.

---

### 7.3 AuthLogout (`POST /auth/logout`)

**Trigger:** Called by the SPA when the user clicks Logout.

#### Request Contract

```
POST /auth/logout
Cookie: refresh_token=<value>
```

No request body.

#### Response Contract

**200 OK** (always, even if token revocation fails)

```json
{ "ok": true }
```

Sets the following response header to clear the cookie:

```
Set-Cookie: refresh_token=; HttpOnly; Secure; SameSite=None; Path=/auth; Max-Age=0
```

#### Logic

1. Parse the `Cookie` header for `refresh_token`.
2. If present, attempt to POST to `https://<COGNITO_DOMAIN>/oauth2/revoke` with `token=<value>` and `client_id=<CLIENT_ID>`. This is best-effort; failure is logged but does not affect the response.
3. Always return 200 with `Set-Cookie: ... Max-Age=0` to clear the cookie, regardless of whether revocation succeeded.

**Rationale for always-200:** The user intends to log out. Returning an error because Cognito was unreachable would confuse the SPA and leave the UI in a partially-logged-out state. The cookie is cleared unconditionally; the refresh token may remain valid in Cognito until its natural expiry, which is an acceptable risk.

#### IAM Permissions

No DynamoDB permissions. Outbound HTTPS to Cognito only.

---

### 7.4 Auth Function Runtime Defaults

| Property | Value |
|---|---|
| Runtime | Node.js 22.x |
| Architecture | arm64 |
| Memory | 256 MB (no DynamoDB; minimal compute) |
| Timeout | 10 s |
| Environment variables | `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID` |

---

## 8. Decisions and Alternatives

### Tech Debt

**TD1 — GSI naming inconsistency:** `api.md` uses the physical SST name `GSI1PK-GSI1SK-index`; `data-model.md` uses the logical alias `DIFFICULTY_INDEX`. These should be unified to one name. The physical SST name is authoritative; `data-model.md` should be updated to use it. Deferred to avoid churn before a schema change occurs.

---

### D1 — CloudFront URL vs. Pre-signed S3 URL for Snippet Content

**Decision:** Return a stable CloudFront URL from GetSnippet, not a time-limited pre-signed S3 URL.

**Rationale:** CloudFront with OAC already restricts who can read the S3 bucket (only CloudFront). Since all snippets are educational content with no PII, a stable URL is acceptable. Pre-signed URLs would introduce expiry management complexity (choosing TTL, handling expired URLs mid-game) and add S3 IAM permissions to the GetSnippet function unnecessarily.

**Alternative considered:** Pre-signed S3 URL with 15-minute TTL. Rejected because it gives no additional confidentiality benefit (the content is not secret — only the answer key is) and adds operational complexity.

### D2 — Single-Table DynamoDB Design

**Decision:** All entities in one DynamoDB table.

**Rationale:** Three Lambda functions, one table reduces connection pool management. Query patterns are well-defined and map cleanly to the PK/SK design. GSI1 for difficulty-filtered snippet lookup is the only secondary index needed.

**Alternative considered:** Separate `Snippets` and `Users` tables. Rejected because it doubles the number of DynamoDB clients/connections to manage and adds no meaningful isolation benefit at the expected scale.

### D3 — Exact-match Correctness (No Partial Credit)

**Decision:** An attempt is correct only if `selectedLines` exactly matches `vulnerableLines` (same elements, same count).

**Rationale:** Partial credit would require a scoring rubric that is complex to communicate to the user ("you got 1 of 2 vulnerable lines"). v1 keeps the feedback loop simple: right or wrong. Partial credit can be introduced in v2 once the UX for it is designed.

**Alternative considered:** Award partial credit proportional to the fraction of correct lines identified. Deferred to v2.

### D4 — Transactional Write in SubmitAnswer

**Decision:** Use `TransactWriteItems` to atomically write the attempt record and update the profile.

**Rationale:** Without a transaction, a Lambda crash between the two writes could leave the profile's `totalAttempts` counter inconsistent with the number of attempt records, or vice versa. The transaction cost (2x DynamoDB write capacity units per item) is acceptable at this scale.

**Alternative considered:** Single-item write with attempt embedded in the profile record. Rejected because unbounded growth of a single item violates DynamoDB's 400 KB item limit over time.

### D5 — Rolling Window Size and Weights

**Decision:** 20-attempt window for upgrades, 10-attempt window for downgrades. Composite score = 70% correct rate + 30% speed score.

**Rationale:** Longer upgrade window prevents lucky streaks from promoting users prematurely. Shorter downgrade window provides faster rescue when a user is out of their depth. The 70/30 weighting was chosen based on the product requirement that correctness is the primary signal; speed is a secondary engagement incentive.

**Alternative considered:** Equal 50/50 weighting. Rejected because speed can be gamed (users who solve slowly but correctly should still progress).

### D6 — `timeTakenMs` Clamping

**Decision:** Cap `timeTakenMs` at 600,000 ms server-side; client-supplied value is used for speed scoring.

**Rationale:** Relying on the client for timing is a known weakness (clients can send any value). Clamping at 10 minutes prevents outliers from distorting speed medians. In v2, server-side timing (record snippet delivery time in DynamoDB; compute elapsed time on submission) would be more robust but adds design complexity.

**Alternative considered:** Server-side timing with a delivery timestamp written to DynamoDB on GetSnippet. Deferred to v2 due to added state management complexity.

---

## 9. Edge Case Probe

The following questions identify gaps, unspecified failure modes, concurrency issues, and implicit assumptions this LLD does not fully address. Each is a candidate for a follow-up design decision or an acceptance test.

### 8.1 Concurrency and Race Conditions

1. **Concurrent first-visit requests:** If a user triggers two simultaneous `GET /api/snippet` calls before their profile is created, the conditional `PutItem` guards against double-creation — but what if the retry `GetItem` after a condition failure also misses (e.g., eventual consistency lag on a DAX or cross-region setup)? The current design uses strong consistency on the retry `GetItem`, which should resolve this, but it should be tested under load.

2. **Double-submit race:** A user double-clicks Submit and two `POST /api/answer` requests arrive within milliseconds of each other with the same `snippetId`. Both will pass validation (both read the snippet before either writes), and both will write separate attempt records. The profile's `totalAttempts` will be incremented twice atomically, which is correct — but the user will see two attempt records for the same snippet. Is that acceptable? An idempotency key is deferred but the risk is real.

3. **Tier change echo:** If `SubmitAnswer` is called concurrently by two tabs (e.g., the user has the app open in two browser windows), both compute the rolling window independently and both may trigger the same tier promotion. Because the profile update uses `SET currentTier = :tier` (not a conditional transition), the second write is idempotent in practice — but the transition event will be signalled twice in each response. The frontend should handle duplicate tier-change notifications gracefully.

4. **Config item absent:** What happens if the `CONFIG#SPEED_MEDIANS` item does not exist in DynamoDB (e.g., the offline update script has never been run)? The current design falls back to `BEGINNER` median for all tiers, which skews speed scores for higher-tier users. A better fallback would use per-tier hardcoded defaults (e.g., BEGINNER=60000ms, INTERMEDIATE=45000ms, ADVANCED=30000ms), but these values are not specified in this LLD.

### 8.2 Data and Content Edge Cases

5. **Zero-snippet tier:** What happens if no snippets have been loaded for the user's current tier (e.g., ADVANCED tier has zero snippets at launch)? `GetSnippet` returns 404 `NO_SNIPPETS_FOR_TIER`. The frontend must handle this gracefully — but there is no fallback to a lower tier. Should the API fall back to INTERMEDIATE if ADVANCED has no snippets? Not currently specified.

6. **Snippet with `vulnerableLineCount = 0`:** The loader script could theoretically write a snippet with an empty `vulnerableLines` set and `vulnerableLineCount = 0`. `SubmitAnswer` would then require `selectedLines` to be empty (but the request schema requires non-empty). This would make the snippet unsubmittable. A loader-time validation constraint is implied but not enforced by this LLD.

7. **`lineCount` mismatch:** If the `lineCount` stored in DynamoDB does not match the actual number of lines in the S3 file (e.g., due to a loader script bug), valid line numbers in the file may be rejected by the server as out-of-range, or vice versa. There is no server-side verification of `lineCount` against the actual file content. A content integrity check at load time or a periodic reconciliation job would mitigate this.

8. **`vulnerableLines` outside `lineCount`:** If the loader stores a `vulnerableLines` entry that exceeds `lineCount`, no user can ever answer correctly (their submission is capped at `lineCount` but the answer key contains a higher line number). This should be caught at load time but is not validated at runtime by any Lambda.

### 8.3 User Journey Edge Cases

9. **SubmitAnswer with an unrecognised `snippetId`:** Returns 404 `SNIPPET_NOT_FOUND`. But should the Lambda also verify that this snippet was actually the one `GetSnippet` returned to this user? Currently it does not — a user could submit an answer for any snippet ID in the system (including snippets from a different tier). This is a minor integrity gap; the attempt will still be scored and recorded against the user's profile, potentially skewing tier evaluation.

10. **GetProgress before first GetSnippet:** Returns 404 `USER_NOT_FOUND`. The frontend should handle this state (e.g., show a "play your first round" prompt). However, if the user somehow hits `/api/progress` directly before authenticating and playing, a confusing 404 could occur. The LLD does not define the frontend handling, but the API contract should be documented for the frontend team.

11. **Attempt history grows unbounded:** The `Query` for rolling window uses `Limit: 20`, so old attempts do not impact performance. However, there is no retention policy on attempt records. Over months of use, a single user's partition could contain thousands of attempt items. A TTL attribute or archival strategy should be considered before the table grows significantly.

12. **User deletes their Cognito account:** Their DynamoDB profile and attempt records remain orphaned. There is no Cognito post-deletion trigger defined in this LLD to clean up DynamoDB. A downstream cleanup Lambda triggered by Cognito's `PostAuthentication` or account deletion event is not designed here.

### 8.4 Scoring and Algorithm Edge Cases

13. **Speed score for first attempt:** On the first `SubmitAnswer`, the rolling window has only 1 item. The composite score, upgrade check (requires 20), and downgrade check (requires 10) all use `windowSize`. A window smaller than 10 means neither upgrade nor downgrade is triggered. Is this the intended behavior? The HLD is silent on a minimum window size requirement. This LLD assumes yes, but it is not explicit in the HLD.

14. **Speed medians config staleness:** The offline script that updates speed medians is not on a defined schedule. If it runs monthly and user behavior shifts, the medians become stale and speed scores degrade. The LLD does not define an SLA or alerting for config freshness.

15. **Composite score tied exactly at threshold:** If `compositeScore == 0.75` exactly, the upgrade check `>= 0.75` passes. If `compositeScore == 0.40` exactly, the downgrade check `< 0.40` does not trigger. These boundary conditions are consistent as written but should be documented as explicit business rules in the product spec to prevent future ambiguity.

16. **User at ADVANCED demotes to INTERMEDIATE then immediately re-meets upgrade threshold:** The rolling window for upgrade requires 20 consecutive high-scoring attempts. After demotion, the window includes the low-scoring attempts that triggered the downgrade. The user cannot re-promote immediately — they must "work off" the old low-scoring attempts as the window slides. This is the intended behavior per the HLD's sliding window design, but it may feel punishing to users. Not an LLD gap, but worth surfacing to product.

### 8.5 Infrastructure and Operational Edge Cases

17. **Lambda cold start during burst traffic:** At launch, all three Lambdas have no provisioned concurrency. A sudden traffic spike (e.g., product launch on Hacker News) could cause cold starts for many users simultaneously. The current design accepts this risk. A threshold for enabling provisioned concurrency should be defined (e.g., if P99 cold start > 1 s over a 5-minute window, enable provisioned concurrency).

18. **DynamoDB hot partition:** All attempts for a single popular user write to `PK=USER#<userId>`. If one user attempts thousands of rounds rapidly (automated testing, stress testing), this partition becomes hot. DynamoDB's adaptive capacity should handle this at modest scale, but it is worth monitoring write throttling metrics per-partition.

19. **CloudFront URL availability:** If the CloudFront distribution is degraded or the S3 object key stored in DynamoDB is stale (e.g., a snippet was re-uploaded with a different key), the `contentUrl` returned by GetSnippet will be valid-looking but broken. The Lambda has no mechanism to verify the URL's liveness before returning it. A head-check against S3 before responding would add latency and S3 permissions; the trade-off is not resolved in this LLD.

20. **Table name environment variable missing:** If `TABLE_NAME`, `CLOUDFRONT_DOMAIN`, or `CONTENT_BUCKET_NAME` is absent from the Lambda environment (e.g., a misconfigured SST deployment), the Lambda will throw at runtime rather than fail at startup. Adding a startup validation check (verify required env vars are set at module initialization, and throw a descriptive error early) would make misconfigurations easier to diagnose.
