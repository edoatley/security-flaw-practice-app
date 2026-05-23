# Low-Level Design: DynamoDB Single-Table Design & S3 Object Layout

**Version:** 0.1 (Draft)
**Status:** In Review
**Date:** 2026-05-16
**Authors:** edoatley
**Parent HLD:** [high-level-design.md](../high-level-design.md)

---

## Table of Contents

1. [Scope & Purpose](#1-scope--purpose)
2. [Entity Definitions](#2-entity-definitions)
3. [Primary Key Schema](#3-primary-key-schema)
4. [GSI Design](#4-gsi-design)
5. [Access Patterns](#5-access-patterns)
6. [S3 Object Layout & Naming Convention](#6-s3-object-layout--naming-convention)
7. [Data Constraints & Validation Rules](#7-data-constraints--validation-rules)
8. [Decisions & Alternatives](#8-decisions--alternatives)
9. [Edge Case Probe](#9-edge-case-probe)

---

## 1. Scope & Purpose

This document specifies the physical data model for the Vulnerability Identification & Education Platform. It covers:

- The single DynamoDB table that stores Snippet metadata, User profile records, Attempt history records, and system Config items.
- The GSI layout needed to serve all access patterns without full table scans.
- The S3 bucket layout for raw snippet content files.
- Data type constraints, validation rules, and encoding decisions.

This document is the authoritative reference for the `load_snippets.py` offline loader, all three Lambda functions (`GetSnippet`, `SubmitAnswer`, `GetProgress`), and any future migration tooling.

---

## 2. Entity Definitions

### 2.1 Snippet

A Snippet represents a single Java code fragment and its associated vulnerability metadata. The raw source text is stored in S3; everything the Lambdas need at runtime lives in DynamoDB.

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `PK` | String | Yes | `SNIPPET#<snippetId>` |
| `SK` | String | Yes | `METADATA` (fixed sentinel value) |
| `snippetId` | String (UUID v4) | Yes | Globally unique; also embedded in `PK` for direct access |
| `entityType` | String | Yes | Constant: `SNIPPET` — used for filtering in queries |
| `title` | String | Yes | Human-readable name, max 120 chars |
| `language` | String | Yes | Constant: `JAVA` at launch |
| `difficulty` | String | Yes | Enum: `BEGINNER`, `INTERMEDIATE`, `ADVANCED` |
| `owaspCategory` | String | Yes | OWASP Top 10 identifier, e.g. `A03_INJECTION` — see §7 for allowed values |
| `vulnerableLines` | List\<Number\> | Yes | Ordered list of 1-indexed line numbers that are vulnerable; **never returned to client before submission** |
| `vulnerableLineCount` | Number | Yes | `len(vulnerableLines)` — denormalised for cheap client reads; enforced by loader |
| `explanation` | String | Yes | Markdown-formatted explanation of the vulnerability and remediation; **never returned to client before submission** |
| `contentKey` | String | Yes | S3 object key for the raw Java source, e.g. `snippets/java/beginner/uuid.java` |
| `source` | String | No | Attribution URL or reference (e.g. CVE number, OVAL entry) |
| `createdAt` | String (ISO 8601) | Yes | UTC timestamp set by loader at write time |
| `updatedAt` | String (ISO 8601) | Yes | UTC timestamp; updated on any attribute change |
| `GSI1PK` | String | Yes | `DIFFICULTY#<difficulty>` — used by `DIFFICULTY_INDEX` GSI (§4.1) |
| `GSI1SK` | String | Yes | `SNIPPET#<snippetId>` — enables random selection by page token within a difficulty bucket |

**Projection note:** `GetSnippet` must NOT project `vulnerableLines` or `explanation` onto the response. These are fetched separately in `SubmitAnswer` using a targeted `GetItem`.

---

### 2.2 User Profile

One record per registered user, keyed on the Cognito `sub` claim. This record holds the current difficulty tier and aggregate counters. It is written on first successful authentication and updated after every `SubmitAnswer` invocation.

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `PK` | String | Yes | `USER#<userId>` (userId = Cognito sub UUID) |
| `SK` | String | Yes | `PROFILE` (fixed sentinel value) |
| `entityType` | String | Yes | Constant: `USER_PROFILE` |
| `userId` | String | Yes | Cognito `sub` claim; also embedded in `PK` |
| `email` | String | Yes | From Cognito token; informational only, not used for auth |
| `currentTier` | String | Yes | Enum: `BEGINNER`, `INTERMEDIATE`, `ADVANCED` |
| `totalAttempts` | Number | Yes | Monotonically increasing count; updated atomically via `ADD` expression |
| `correctAttempts` | Number | Yes | Count of correct submissions; updated atomically |
| `createdAt` | String (ISO 8601) | Yes | Timestamp of first login |
| `updatedAt` | String (ISO 8601) | Yes | Timestamp of last tier or counter update |

---

### 2.3 Attempt

One record per `SubmitAnswer` call. Attempts are children of a User in the single table. The most recent 20 attempts are used by the adaptive difficulty algorithm (see HLD §4.7). Reads are always scoped to a specific user ordered by time, so the SK encodes a sortable timestamp.

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `PK` | String | Yes | `USER#<userId>` — same partition as the User Profile |
| `SK` | String | Yes | `ATTEMPT#<ISO8601-UTC>#<snippetId>` — ISO 8601 string sorts chronologically; `snippetId` suffix breaks ties |
| `entityType` | String | Yes | Constant: `ATTEMPT` |
| `snippetId` | String | Yes | The snippet that was attempted |
| `timestamp` | String (ISO 8601) | Yes | UTC submission time at millisecond precision, e.g. `2026-05-16T10:23:45.123Z` |
| `correct` | Boolean | Yes | `true` if all submitted lines exactly match `vulnerableLines`; `false` otherwise |
| `timeTakenMs` | Number | Yes | Client-reported milliseconds from snippet load to submission; validated ≥ 0 and ≤ 600,000 (10 minute cap) |
| `tierId` | String | Yes | The user's `currentTier` at the time of submission — allows retrospective tier-segmented analysis |
| `submittedLines` | List\<Number\> | Yes | The lines the user actually submitted; stored for audit and future ML use |

**Important:** Attempts are never deleted. The rolling-window algorithm in `GetProgress` fetches the last 20 attempts using `ScanIndexForward=false LIMIT 20`. Older attempts remain for historical analytics.

---

### 2.4 Config

A small number of system-wide configuration items are stored in the same table, avoiding a separate parameter store dependency for low-update data. Currently this covers the per-difficulty median response times used by the speed-score component of the adaptive difficulty algorithm.

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `PK` | String | Yes | `CONFIG#<configKey>` |
| `SK` | String | Yes | `V0` (a version sentinel; increment if the config schema changes) |
| `entityType` | String | Yes | Constant: `CONFIG` |
| `configKey` | String | Yes | Logical name, e.g. `SPEED_MEDIANS` |
| `value` | Map | Yes | Arbitrary JSON-compatible map; schema is config-key-specific |
| `updatedAt` | String (ISO 8601) | Yes | Set by whichever process last wrote this item |

**Example — `SPEED_MEDIANS` value:**

```json
{
  "BEGINNER": 45000,
  "INTERMEDIATE": 90000,
  "ADVANCED": 180000
}
```

These median values are updated offline (e.g. a scheduled Lambda or manual script) and cached in the Lambda execution environment to avoid a DynamoDB read on every request.

---

## 3. Primary Key Schema

The table uses a composite key (`PK` + `SK`). The `PK` establishes the entity partition; the `SK` either distinguishes the entity subtype within that partition (e.g. `PROFILE` vs `ATTEMPT#...`) or acts as a fixed sentinel for singleton records.

| Entity | PK Pattern | SK Pattern | Example PK | Example SK |
|---|---|---|---|---|
| Snippet | `SNIPPET#<snippetId>` | `METADATA` | `SNIPPET#a1b2c3d4-...` | `METADATA` |
| User Profile | `USER#<userId>` | `PROFILE` | `USER#f9e8d7c6-...` | `PROFILE` |
| Attempt | `USER#<userId>` | `ATTEMPT#<timestamp>#<snippetId>` | `USER#f9e8d7c6-...` | `ATTEMPT#2026-05-16T10:23:45.123Z#a1b2c3d4-...` |
| Config | `CONFIG#<configKey>` | `V0` | `CONFIG#SPEED_MEDIANS` | `V0` |

**Why Attempts share the User partition:** All reads of Attempts are always scoped to a single user. Keeping Attempts in the same partition as the User Profile allows a single `Query` with a key condition on `PK = USER#<userId> AND begins_with(SK, 'ATTEMPT#')`, returning items in chronological order without any secondary index. This is the one query that benefits most from DynamoDB's native sort.

---

## 4. GSI Design

### 4.1 `DIFFICULTY_INDEX`

| Property | Value |
|---|---|
| Index Name | `DIFFICULTY_INDEX` |
| Partition Key | `GSI1PK` (String) |
| Sort Key | `GSI1SK` (String) |
| Projection | `ALL` |
| Billing | Provisioned alongside base table; no additional key schema cost |

**Purpose:** Enables `GetSnippet` to retrieve all Snippets at a given difficulty tier efficiently. The Lambda queries all snippets at the requested difficulty with `Limit: 200`, excludes recently seen snippets, and picks a random candidate using `Math.random()`.

**Populated by:** The snippet loader sets `GSI1PK = DIFFICULTY#<difficulty>` and `GSI1SK = SNIPPET#<snippetId>` on every Snippet record. User, Attempt, and Config records do **not** populate `GSI1PK`/`GSI1SK`, so they do not appear in this index.

**Random selection detail:** The Lambda queries `DIFFICULTY_INDEX` with `GSI1PK = DIFFICULTY#<tier>`, `Limit: 200`, filters out snippets already attempted recently (using a parallel attempt query), then selects one item via `Math.floor(Math.random() * candidates.length)`. `Math.random()` is acceptable for gameplay randomness — cryptographic security is not required.

At expected snippet counts (< 500 per tier at launch) a single-page query covers the full set. A future optimisation can use a UUID-seeded `ExclusiveStartKey` for larger inventories.

**Why not a GSI on `difficulty` attribute directly:** DynamoDB GSIs require the projected attribute to be the GSI PK. Using a prefixed compound value (`DIFFICULTY#BEGINNER`) keeps the index clean and prevents non-Snippet entities from polluting the partition even if they happen to have a `difficulty` attribute.

**No additional GSIs at launch:** All other access patterns are served by the base table or `DIFFICULTY_INDEX`. A future `OWASP_CATEGORY_INDEX` may be added if per-category filtering is required.

---

## 5. Access Patterns

All read and write operations performed by the three Lambda functions are enumerated below.

| # | Operation | Caller | Index | Key Condition | Filter | Notes |
|---|---|---|---|---|---|---|
| AP-1 | Get user profile | GetSnippet, GetProgress | Base table | `PK = USER#<userId>` AND `SK = PROFILE` | — | `GetItem` — exact key lookup |
| AP-2 | Create user profile | SubmitAnswer (first login) | Base table | `PK = USER#<userId>` AND `SK = PROFILE` | — | `PutItem` with `attribute_not_exists(PK)` condition |
| AP-3 | Update user tier + counters | SubmitAnswer | Base table | `PK = USER#<userId>` AND `SK = PROFILE` | — | `UpdateItem` with `ADD totalAttempts :one`, `SET currentTier`, `SET updatedAt` |
| AP-4 | Get snippet metadata (safe projection) | GetSnippet | Base table | `PK = SNIPPET#<snippetId>` AND `SK = METADATA` | — | `GetItem`; Lambda explicitly omits `vulnerableLines` and `explanation` from response |
| AP-5 | Get snippet metadata with answer key | SubmitAnswer | Base table | `PK = SNIPPET#<snippetId>` AND `SK = METADATA` | — | `GetItem`; returns full item including `vulnerableLines` and `explanation` |
| AP-6 | Random snippet by difficulty | GetSnippet | `DIFFICULTY_INDEX` | `GSI1PK = DIFFICULTY#<tier>`, `Limit=200` | — | Client-side `Math.random()` pick after excluding recent attempts (see §4.1) |
| AP-7 | Write attempt record | SubmitAnswer | Base table | `PK = USER#<userId>` AND `SK = ATTEMPT#<ts>#<snippetId>` | — | `PutItem`; SK timestamp collision probability negligible |
| AP-8 | Get last N attempts (rolling window) | GetProgress, SubmitAnswer | Base table | `PK = USER#<userId>` AND `begins_with(SK, 'ATTEMPT#')` | — | `Query`, `ScanIndexForward=false`, `Limit=20` |
| AP-9 | Get speed medians config | SubmitAnswer, GetProgress | Base table | `PK = CONFIG#SPEED_MEDIANS` AND `SK = V0` | — | `GetItem`; result cached in Lambda warm instance |
| AP-10 | Write/update speed medians config | Offline script / scheduled Lambda | Base table | `PK = CONFIG#SPEED_MEDIANS` AND `SK = V0` | — | `PutItem` |

### Notes on AP-4 vs AP-5

`GetSnippet` and `SubmitAnswer` both read the Snippet item, but they have different security requirements:

- **AP-4 (GetSnippet):** Must never expose `vulnerableLines` or `explanation`. The Lambda constructs its response object by explicitly selecting only safe attributes. It does **not** use a DynamoDB `ProjectionExpression` to hide the answer key — the full item is fetched internally — because the Lambda also needs `vulnerableLineCount` which is safe to return. The redaction is done in application code.
- **AP-5 (SubmitAnswer):** Fetches the full item to compare `vulnerableLines` against the client submission. On a **correct** answer the response includes `vulnerableLines` and `explanation` so the frontend can show which lines were vulnerable and why. On an **incorrect** answer only the correctness result is returned — `vulnerableLines` and `explanation` are omitted so the user can try again without seeing the answer.

---

## 6. S3 Object Layout & Naming Convention

### 6.1 Bucket Structure

The snippet content bucket uses a hierarchical prefix layout to enable prefix-based access policies and make CLI browsing straightforward. All objects are private; CloudFront with OAC is the only read path.

```
s3://<bucket-name>/
└── snippets/
    └── java/
        ├── beginner/
        │   ├── <snippetId>.java
        │   └── ...
        ├── intermediate/
        │   ├── <snippetId>.java
        │   └── ...
        └── advanced/
            ├── <snippetId>.java
            └── ...
```

### 6.2 Object Key Convention

```
snippets/java/<difficulty_lowercase>/<snippetId>.java
```

**Examples:**

| Snippet | S3 Key |
|---|---|
| Beginner SQL injection | `snippets/java/beginner/a1b2c3d4-e5f6-7890-abcd-ef1234567890.java` |
| Advanced deserialization | `snippets/java/advanced/b2c3d4e5-f6a7-8901-bcde-f12345678901.java` |

**Rules:**

- `<snippetId>` is a lowercase UUID v4 with hyphens, matching the `snippetId` in DynamoDB exactly.
- `<difficulty_lowercase>` is the lowercase form of the DynamoDB `difficulty` attribute (`beginner`, `intermediate`, `advanced`).
- File extension is always `.java` regardless of whether the snippet is a complete compilable class or a fragment.
- No spaces, no uppercase, no special characters beyond hyphens and dots.
- The `contentKey` stored in DynamoDB is the full relative key: `snippets/java/beginner/<uuid>.java`. It does **not** include the bucket name or `s3://` prefix.

### 6.3 Object Metadata (S3 Metadata Headers)

Each object is uploaded with the following S3 user-defined metadata to make offline tooling and debugging easier without requiring a DynamoDB lookup:

| Metadata Key | Value | Example |
|---|---|---|
| `x-amz-meta-snippet-id` | UUID of the snippet | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `x-amz-meta-difficulty` | Uppercase difficulty | `BEGINNER` |
| `x-amz-meta-owasp-category` | OWASP category string | `A03_INJECTION` |
| `x-amz-meta-title` | Snippet title (URL-encoded if needed) | `SQL+Injection+in+Login+Form` |

**Content-Type:** `text/plain; charset=utf-8` — not `application/java` or `text/x-java-source`, because CloudFront must serve this as plain text for the browser syntax-highlighter to consume.

### 6.4 Loader Script Behavior (`load_snippets.py`)

The offline Python loader is the only process that writes to S3 and to the DynamoDB Snippets partition. Its sequence for each snippet is:

1. Validate local `.java` file and companion `metadata.json` entry (required fields, enum values, line number bounds).
2. Compute `snippetId` (generate UUID v4 if not already assigned).
3. Count lines in the `.java` file; verify `vulnerableLines` values are all within `[1, lineCount]`.
4. Verify `vulnerableLineCount == len(vulnerableLines)`.
5. Upload `.java` file to S3 with correct key and metadata headers. Use `--no-progress` flag for CI use.
6. Write DynamoDB item atomically with `PutItem` + `condition_expression="attribute_not_exists(PK)"` to prevent accidental overwrites. On re-runs, use `--force` flag to use unconditional `PutItem`.
7. Print a summary line per snippet: `[OK] <snippetId> -> <s3Key>`.

The loader never reads from production DynamoDB except to validate that a `snippetId` does not already exist when operating in non-force mode.

---

## 7. Data Constraints & Validation Rules

### 7.1 Allowed OWASP Category Values

All Snippets must use one of the following `owaspCategory` values, corresponding to OWASP Top 10 2021:

| Value | OWASP 2021 Name |
|---|---|
| `A01_BROKEN_ACCESS_CONTROL` | Broken Access Control |
| `A02_CRYPTOGRAPHIC_FAILURES` | Cryptographic Failures |
| `A03_INJECTION` | Injection |
| `A04_INSECURE_DESIGN` | Insecure Design |
| `A05_SECURITY_MISCONFIGURATION` | Security Misconfiguration |
| `A06_VULNERABLE_AND_OUTDATED_COMPONENTS` | Vulnerable and Outdated Components |
| `A07_IDENTIFICATION_AND_AUTHENTICATION_FAILURES` | Identification and Authentication Failures |
| `A08_SOFTWARE_AND_DATA_INTEGRITY_FAILURES` | Software and Data Integrity Failures |
| `A09_SECURITY_LOGGING_AND_MONITORING_FAILURES` | Security Logging and Monitoring Failures |
| `A10_SERVER_SIDE_REQUEST_FORGERY` | Server-Side Request Forgery |

Validation is enforced by the loader script. Lambda functions trust the value stored in DynamoDB and do not re-validate it.

### 7.2 Field-Level Constraints

| Field | Constraint | Enforcement Point |
|---|---|---|
| `snippetId` | UUID v4 format, lowercase with hyphens | Loader, Lambda input if ever passed |
| `title` | 1–120 characters, no control characters | Loader |
| `difficulty` | Enum: `BEGINNER`, `INTERMEDIATE`, `ADVANCED` | Loader, `SubmitAnswer` (reads `tierId` back) |
| `owaspCategory` | One of 10 allowed values (§7.1) | Loader |
| `vulnerableLines` | Non-empty list; each element is a positive integer; all values unique; all ≤ total line count of the `.java` file | Loader |
| `vulnerableLineCount` | Equals `len(vulnerableLines)` | Loader |
| `explanation` | Non-empty string; Markdown permitted | Loader |
| `contentKey` | Matches regex `^snippets/java/(beginner\|intermediate\|advanced)/[0-9a-f-]{36}\.java$` | Loader |
| `timeTakenMs` (Attempt) | Integer; 0 ≤ value ≤ 600,000 (10 min cap; values above this are clamped, not rejected) | `SubmitAnswer` Lambda |
| `submittedLines` (Attempt) | List of integers; length ≤ `vulnerableLineCount`; each value ≥ 1 | `SubmitAnswer` Lambda |
| `userId` | UUID format (Cognito sub) | API Gateway JWT authorizer (implicit) |
| `email` | Basic format check | Not re-validated; taken from JWT claim |
| `currentTier` | Enum: `BEGINNER`, `INTERMEDIATE`, `ADVANCED` | `SubmitAnswer` Lambda on write |

### 7.3 Answer Evaluation Logic

`SubmitAnswer` compares the client's `submittedLines` against `vulnerableLines` using **exact set equality** (order-independent):

```
correct = set(submittedLines) == set(vulnerableLines)
```

Partial credit is **not** awarded in v1. If a user submits 2 of 3 vulnerable lines, the attempt is recorded as `correct=false`. This simplification is noted as a potential enhancement in future versions.

### 7.4 DynamoDB Item Size

DynamoDB enforces a 400 KB per-item limit. The maximum anticipated item size is an Attempt record with large `submittedLines` lists — but since vulnerable line counts are bounded by the snippet size (typically <100 lines), and explanations are stored on the Snippet not the Attempt, this limit will not be approached in practice.

### 7.5 Timestamps

All timestamps are stored as ISO 8601 strings in UTC with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). DynamoDB's String type is used rather than Number (epoch ms) to preserve human-readability in the console and make the sort-key ordering on Attempt records visually verifiable.

---

## 8. Decisions & Alternatives

### 8.1 Why Single-Table Design?

**Decision:** All entity types (Snippets, User Profiles, Attempts, Config) live in one DynamoDB table.

**Rationale:**
- All runtime access patterns are either single-entity lookups (GetItem by composite key) or queries scoped to one partition (all Attempts for a user). No cross-partition join is ever needed in the hot path.
- A single table reduces IAM surface (one table ARN + one GSI ARN), simplifies CloudFormation/CDK stacking, and avoids the cold-start penalty of initialising multiple DynamoDB clients.
- DynamoDB pricing is per read/write unit, not per table; there is no cost disadvantage to consolidation.

**Alternative considered — separate tables per entity:**
- Simpler mental model for developers unfamiliar with single-table design.
- Rejected because it would require multiple table ARNs in IAM policies, multiple streams if change data capture is added later, and provides no access-pattern benefit given our query shapes.

### 8.2 Why S3 for Snippet Content?

**Decision:** Raw Java source is stored in S3; only metadata and answer keys are in DynamoDB.

**Rationale:**
- DynamoDB items are limited to 400 KB. Java snippet files could approach or exceed this if they contain class-level context.
- Snippet content is immutable after upload and benefits from CloudFront CDN caching. DynamoDB does not integrate with CloudFront natively.
- Separating content from metadata means `GetSnippet` can return a pre-signed URL (or CloudFront URL) and the browser fetches the file directly — Lambda never proxies binary content.
- Answer keys (`vulnerableLines`, `explanation`) are never stored in S3, so they cannot be retrieved even if a user somehow obtained the direct S3 URL.

**Alternative considered — store content in DynamoDB as a String attribute:**
- Simpler loader (one write target).
- Rejected because it conflates mutable metadata with immutable content, hits item-size limits on larger snippets, and prevents CDN-level caching.

### 8.3 Why ISO 8601 String for Timestamps (not epoch Number)?

**Decision:** Timestamps stored as ISO 8601 strings.

**Rationale:**
- Attempt `SK` must sort chronologically. DynamoDB sorts String SKs lexicographically. ISO 8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`) sort correctly lexicographically without any special handling.
- Epoch-as-Number would require a separate sort key or a padding scheme to achieve the same property as a String SK.
- Human-readable timestamps reduce debugging friction.

**Alternative considered — epoch milliseconds as Number:**
- Slightly smaller storage footprint (~13 chars vs ~24 chars).
- Rejected because the SK sort advantage of ISO 8601 strings outweighs the storage savings.

### 8.4 Why `begins_with(SK, 'ATTEMPT#')` Instead of a Dedicated Attempts Partition?

**Decision:** Attempts share the `USER#<userId>` partition with the User Profile, distinguished by SK prefix.

**Rationale:**
- `GetProgress` and `SubmitAnswer` always need both the User Profile and recent Attempts. A single `Query` with `begins_with(SK, 'ATTEMPT#')` (plus a separate `GetItem` for the Profile) is two DynamoDB operations. If Attempts were in a separate partition, the same two operations would still be needed — no benefit.
- Keeping them co-located makes it possible to fetch both in a single `BatchGetItem` or `TransactGetItems` call if needed.

### 8.5 Why `ALL` Projection on `DIFFICULTY_INDEX`?

**Decision:** Project all attributes onto `DIFFICULTY_INDEX`.

**Rationale:**
- `GetSnippet` reads from `DIFFICULTY_INDEX` and then immediately uses the snippet metadata (title, owaspCategory, vulnerableLineCount, contentKey) to construct its response. If only keys were projected, a subsequent `GetItem` on the base table would be required — doubling the read cost.
- With `ALL` projection, the GSI query result contains everything needed (minus the redacted answer key, which is handled in application code).

**Alternative considered — `KEYS_ONLY` or `INCLUDE` projection:**
- Lower GSI storage cost.
- Rejected because the second base-table read negates the storage saving and adds latency.

### 8.6 Random Snippet Selection Without a Scan

**Decision:** Use the UUID-range wrap-around query on `DIFFICULTY_INDEX`.

**Rationale:**
- DynamoDB does not have a `RANDOM` keyword or a `SAMPLE` function.
- Maintaining a separate count attribute and doing offset-based pagination is expensive (requires reading all preceding items).
- The UUID-range approach is O(1) in cost (one or two Queries, each returning 1 item) and gives near-uniform distribution.

**Alternative considered — pre-compute a random selection in `GetProgress` and cache in the User Profile:**
- Pre-selecting "next snippet" avoids the wrap-around edge case.
- Rejected because it couples snippet selection logic to profile updates, complicates the User Profile write, and makes it harder to exclude recently-seen snippets in future.

---

## 9. Edge Case Probe

This section lists unresolved or underspecified behaviours that the design above does not yet fully address. Each item is a "what happens when..." question intended to surface gaps before implementation begins.

### 9.1 Concurrency & Race Conditions

- **What happens when two requests from the same user hit `SubmitAnswer` simultaneously** (e.g. double-tap on a mobile device)? Both will attempt to write an Attempt record with SK `ATTEMPT#<ts>#<snippetId>`. If the timestamps differ by ≥1 ms, two Attempt records are created and `totalAttempts` is incremented twice. If they collide exactly, the second `PutItem` silently overwrites the first. Neither outcome is correctly handled — is a `ConditionExpression` on the Attempt SK needed to reject duplicates?

- **What happens when `SubmitAnswer` reads the User Profile (AP-1) and then writes the updated tier (AP-3) but another concurrent `SubmitAnswer` writes in between?** The tier transition logic is a read-modify-write. Without optimistic locking (a `version` attribute + condition expression), two concurrent correct submissions could both trigger a tier upgrade, but the second write's tier may be based on stale counter values.

### 9.2 Empty States

- **What happens when a new difficulty tier has zero Snippets** (e.g. `ADVANCED` has no entries yet)? The `DIFFICULTY_INDEX` query for `DIFFICULTY#ADVANCED` returns empty, and the wrap-around query also returns empty. `GetSnippet` currently has no defined fallback — should it downgrade to `INTERMEDIATE` automatically, or return a 404 with a user-friendly message?

- **What happens when a user has zero Attempts** and `GetProgress` tries to compute a rolling window score? The response object must handle an empty list without a division-by-zero error. The current spec does not define what `GetProgress` returns for a brand-new user with no history.

### 9.3 Snippet Deduplication & Repetition

- **What happens when the random UUID in the wrap-around query selects the same snippet the user just attempted?** There is no exclusion mechanism. A user could receive the same snippet twice in a row. Is that acceptable, or should `GetSnippet` maintain a short "recently seen" list (e.g. last 5 snippetIds) in the User Profile to exclude?

- **What happens if a user has attempted every snippet at their difficulty tier?** Once a user exhausts the pool, they will cycle through the same snippets repeatedly. There is no "shuffle" or "exhaustion" state defined.

### 9.4 Snippet Lifecycle

- **What happens when a snippet needs to be removed or corrected after it has been attempted?** If `vulnerableLines` on a Snippet record is updated to fix an error, existing Attempt records with `correct=true` based on the old answer key will become historically inaccurate. There is no versioning scheme for Snippet records, no tombstone mechanism, and no policy on whether to recount historical attempts.

- **What happens if the S3 object is deleted but the DynamoDB record still exists?** `GetSnippet` will return a valid metadata response with a broken `contentKey`. The SPA will attempt to fetch the file and receive a 403 or 404 from CloudFront/S3, causing a silent failure with no server-side error logged.

### 9.5 Adaptive Difficulty Tier Transitions

- **What happens when a user's rolling window spans a tier boundary** (i.e. the last 20 attempts include some at `BEGINNER` and some at `INTERMEDIATE`)? The `tierId` attribute on each Attempt records the tier at submission time, but the rolling-window algorithm as described in the HLD operates on raw correct/incorrect counts without filtering by tier. A user who just promoted to `INTERMEDIATE` carries their `BEGINNER` streak into the new window, potentially triggering an immediate second promotion.

- **What happens when the speed-medians Config item does not exist** (e.g. on a cold environment with no data)? `GetProgress` and `SubmitAnswer` cache the medians item. If the item is missing, the cache stores `null` and the speed-score component of the adaptive algorithm has no baseline. Is the speed score silently dropped (weight falls back to 0%:100% correct rate), or does the Lambda return an error?

### 9.6 Security & Input Validation

- **What happens when `timeTakenMs` is reported as 0 or a negative number** by a client that has been tampered with? The current constraint says `≥ 0`, but 0 ms is physically impossible. Should values below a minimum plausible threshold (e.g. 500 ms) be capped or flagged as suspicious rather than stored verbatim?

- **What happens when `submittedLines` contains duplicate line numbers** (e.g. `[5, 5, 7]`)? The set-equality check (`set(submittedLines) == set(vulnerableLines)`) would silently deduplicate them, allowing a submission of `[5, 5, 7]` to match `[5, 7]`. This could be exploited if the client can send duplicates to reduce the effective number of distinct lines it needs to identify. Should the Lambda reject submissions with duplicate line numbers explicitly?

- **What happens when a Cognito `sub` changes** (e.g. user account is deleted and re-created with the same email)? The new `sub` will not find a User Profile, so a fresh profile is created — this is correct. But the old profile and its Attempts remain orphaned in the table. There is no TTL or cleanup mechanism defined.

### 9.7 Operational & Loader Concerns

- **What happens when the loader script is interrupted mid-run** (e.g. after uploading to S3 but before writing to DynamoDB)? The S3 object exists without a corresponding DynamoDB record. A re-run with `--force` would overwrite both, but without `--force` the S3 upload would succeed and the DynamoDB `attribute_not_exists(PK)` condition would not apply (since there is no existing DynamoDB item). This half-written state is undetected by the loader as designed.

- **What happens when two instances of the loader run concurrently** against the same `metadata.json` file? Race conditions on the `attribute_not_exists(PK)` condition could cause one to succeed and one to fail silently, depending on timing. There is no distributed lock mechanism described.

- **What happens when the DynamoDB table's `DIFFICULTY_INDEX` GSI is in `BACKFILLING` state** (during initial provisioning or after an index rebuild)? Queries against the GSI may return incomplete results. `GetSnippet` has no retry or fallback path for this transient state.
