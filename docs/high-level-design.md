# High-Level Design: Vulnerability Identification & Education Platform

**Version:** 0.4 (Draft)
**Status:** Awaiting approval
**Date:** 2026-05-16

---

## 1. Problem Statement & Goals

Developers and security engineers need low-friction, hands-on practice identifying real vulnerability patterns before they encounter them in production. Existing resources (blog posts, courses) are passive. This platform makes it active: show a Java code snippet, ask the user to identify the vulnerable line(s), score them, and explain why.

**Goals:**
- Reduce time-to-first-practice to under 2 minutes from landing page
- Cover all OWASP Top 10 categories with at least one snippet at launch
- Give users a sense of genuine progression via adaptive difficulty
- Keep operational overhead minimal (serverless, no containers to manage)

**Non-goals (v1):**
- Social/federated login (GitHub, Google) — deferred
- Community-contributed snippets — deferred
- Multi-language support — Java only at launch
- Multiplayer / real-time leaderboards — deferred
- Admin UI for snippet authoring — snippets loaded via offline Python script at launch
- Multiple vulnerabilities per snippet
- Shift-click multi-line selection — deferred; users click individual lines instead

---

## 2. Target Users

| Persona | Primary Need | Key UX Consideration |
|---|---|---|
| Junior Developer | Learn what unsafe code looks like | Clear explanations, beginner-friendly snippets |
| Security Engineer | Maintain audit muscle memory | Fast flow, harder snippets, no hand-holding |
| CS Student | Practical exposure to OWASP patterns | Context about why something is dangerous |

---

## 3. System Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    User (Browser)                   │
└────────────────────────┬────────────────────────────┘
                         │ HTTPS
              ┌──────────▼──────────┐
              │   CloudFront CDN    │
              └──────┬──────────────┘
                     │                  ┌─────────────────┐
           ┌─────────▼──────┐           │  Cognito User   │
           │  S3 Static Site │           │  Pool + Hosted  │
           │  (React SPA)    │           │  UI             │
           └─────────────────┘           └────────┬────────┘
                                                  │ JWT
                     ┌────────────────────────────▼────────┐
                     │        API Gateway v2 (HTTP API)    │
                     │        JWT Authorizer (Cognito)     │
                     └──────────────┬──────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
    ┌─────────▼──────┐   ┌──────────▼──────┐   ┌──────────▼──────┐
    │ Lambda:        │   │ Lambda:         │   │ Lambda:         │
    │ GetSnippet     │   │ SubmitAnswer    │   │ GetProgress     │
    └────────┬───────┘   └────────┬────────┘   └────────┬────────┘
             │                    │                      │
    ┌────────▼───────┐   ┌────────▼────────────────────▼────────┐
    │ S3: Snippet    │   │           DynamoDB                   │
    │ Content Bucket │   │  - Snippets table (metadata/answers) │
    └────────────────┘   │  - Users table (history/scores)      │
                         └──────────────────────────────────────┘
```

### Data flow for a typical round:
1. User authenticates via Cognito Hosted UI → receives JWT
2. SPA calls `GET /api/snippet` with JWT → Lambda selects snippet based on user's adaptive difficulty tier, returns snippet ID + S3 pre-signed URL (or public CloudFront URL) for content + metadata (language, OWASP category, line count)
3. SPA fetches snippet text directly from S3/CloudFront (no Lambda involved)
4. User clicks line(s) and submits → `POST /api/answer` with JWT + snippet ID + selected lines
5. Lambda validates answer against DynamoDB metadata, records attempt in Users table, returns result + explanation
6. SPA calls `GET /api/progress` to refresh difficulty tier display

---

## 4. Component Breakdown

### 4.1 Frontend (React SPA)

- Hosted on S3, served via CloudFront
- Built with Vite + React
- Key screens: Login redirect → Game screen → Result/Explanation → Progress dashboard
- Code display: syntax-highlighted Java via a library (e.g. `react-syntax-highlighter`)
- Line selection: clickable line numbers; users may select multiple individual lines up to the count of vulnerable lines in the snippet (server enforces the cap on submission); shift-click deferred
- Auth: uses Cognito Hosted UI redirect flow; stores JWT in memory (not localStorage) to mitigate XSS token theft; uses refresh token in httpOnly cookie

### 4.2 Cognito User Pool

- Email + password only at launch
- Hosted UI handles sign-up, sign-in, password reset
- JWT passed as `Authorization: Bearer` header on all API calls
- API Gateway v2 JWT authorizer validates tokens without Lambda

### 4.3 API Gateway v2

- HTTP API (not REST API) — lower latency, lower cost
- Single JWT authorizer attached to all routes except health check
- Routes (JWT authorizer applied to `/api/*` only):
  - `GET /api/snippet` — fetch next snippet for user
  - `POST /api/answer` — submit answer
  - `GET /api/progress` — fetch user stats and current difficulty tier
  - `POST /auth/session` — set httpOnly refresh token cookie (no JWT authorizer)
  - `POST /auth/refresh` — exchange refresh cookie for new access token (no JWT authorizer)
  - `POST /auth/logout` — clear cookie and revoke token with Cognito (no JWT authorizer)

### 4.4 Lambda Functions

Five focused functions. The three game functions share a DynamoDB client (bundled via esbuild). The two auth functions are standalone and operate without a JWT authorizer.

| Function | Route | Responsibility |
|---|---|---|
| `GetSnippet` | `GET /api/snippet` | Query user's current difficulty tier; select a random snippet at that tier; return metadata + CloudFront content URL. Returns `TIER_COMPLETE` status when no snippets remain at the user's tier. |
| `SubmitAnswer` | `POST /api/answer` | Validate submitted line numbers; write attempt record atomically; re-evaluate difficulty tier; return correctness + OWASP category + explanation |
| `GetProgress` | `GET /api/progress` | Aggregate attempt history; compute rolling-window score and current tier; return stats |
| `AuthSession` | `POST /auth/session` | Receives refresh token from SPA after Cognito Hosted UI redirect; sets it as an httpOnly cookie (`Path=/auth`). No JWT authorizer. |
| `AuthRefresh` | `POST /auth/refresh` | Reads httpOnly refresh cookie; exchanges it with Cognito for a new access token; returns access token in response body. No JWT authorizer. |
| `AuthLogout` | `POST /auth/logout` | Clears the httpOnly cookie and revokes the refresh token with Cognito. No JWT authorizer. |

### 4.5 DynamoDB Tables

**Snippets table**
- PK: `snippetId` (UUID)
- Attributes: `language`, `difficulty` (BEGINNER/INTERMEDIATE/ADVANCED), `owaspCategory`, `vulnerableLines` (array of line numbers), `explanation`, `contentKey` (S3 object key), `title`, `source`
- GSI on `difficulty` for efficient tier-filtered random selection

**Users table**
- PK: `userId` (Cognito sub)
- Attributes: `currentTier`, `totalAttempts`, `correctAttempts`
- SK: `attemptId` for attempt records (single-table design)
- Attempt record attributes: `snippetId`, `timestamp`, `correct`, `timeTakenMs`, `tierId`

### 4.6 S3 Snippet Content Bucket

- Stores raw Java snippet files as plain text (`.java` or `.txt`)
- Not publicly accessible; CloudFront OAC (Origin Access Control) restricts access
- Snippet loader script: a Python script (`scripts/load_snippets.py`) run offline; reads a local directory of `.java` files + a companion `metadata.json`, uploads content to S3, and writes metadata records to DynamoDB
- Object key matches `contentKey` in DynamoDB Snippets table

### 4.7 Adaptive Difficulty Algorithm

Tier transitions are computed by `GetProgress` / `SubmitAnswer` and stored on the Users record.

**Signal:** rolling window of last **20 attempts**
- **Correct rate** (weight 70%): correct answers / total in window
- **Speed score** (weight 30%): normalised time-to-answer vs. per-difficulty median (computed offline periodically, stored as a config item in DynamoDB)

**Tier transition rules:**
- BEGINNER → INTERMEDIATE: rolling score ≥ 0.75 for 20 consecutive attempts
- INTERMEDIATE → ADVANCED: rolling score ≥ 0.75 for 20 consecutive attempts
- ADVANCED → INTERMEDIATE: rolling score < 0.40 for 10 consecutive attempts
- INTERMEDIATE → BEGINNER: rolling score < 0.40 for 10 consecutive attempts

Tier is re-evaluated after every `SubmitAnswer` call and written back to the Users record.

---

## 5. Key Design Decisions (Summary)

| Decision | Choice | Rationale |
|---|---|---|
| Authentication | Cognito User Pool + Hosted UI | Speed to ship; social login deferred |
| Snippet storage | Hybrid S3 (content) + DynamoDB (metadata) | Large text stays in CDN layer; answer keys never reach client |
| Difficulty | User-adaptive, rolling window, 3 tiers | Engaging progression without requiring manual tier selection |
| Line selection | Individual clicks, capped at vulnerability line count | Shift-click deferred; cap enforced server-side on submission |
| API type | HTTP API v2 (not REST API) | Lower latency and cost; JWT authorizer built-in |
| JWT storage | Memory + httpOnly refresh cookie | Mitigates XSS token theft vs. localStorage |
| Snippet languages | Java only at launch | Keeps syntax highlighting and content authoring focused |

---

## 6. Security Requirements

- All API routes require valid Cognito JWT (validated by API Gateway, not Lambda)
- Snippet answer keys (`vulnerableLines`, `explanation`) are never returned to the client — only after a correct submission or on explicit reveal
- Snippet content served via CloudFront with OAC; S3 bucket has no public access
- CSP, HSTS, and X-Content-Type-Options headers set on CloudFront distribution
- Lambda IAM roles scoped to minimum: read Snippets table, read/write own user's records only (enforced via Cognito sub in partition key)
- Input validation on `SubmitAnswer`: line numbers must be integers within snippet line count; number of submitted lines must not exceed the snippet's `vulnerableLineCount`

---

## 7. Non-Goals (Explicit Deferrals)

- Social/federated identity (GitHub, Google OAuth)
- Community snippet contributions or admin authoring UI
- Real-time leaderboards
- Multiple languages beyond Java
- Multiple vulnerabilities per snippet
- Mobile-native app
- OVAL Hub automated ingestion pipeline (manual curation at launch)
