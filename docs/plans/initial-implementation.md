# Implementation Plan: Security Flaw Practice App

Full build-out from infrastructure skeleton to production-hardened live site.

**Status tracking:** `[x]` = complete, `[ ]` = not started / stub only

---

## Phase 1 — Infrastructure Skeleton ✅ COMPLETE

**Goal:** All AWS resources deployed; all 6 routes reachable with correct status codes.

- [x] `sst.config.ts` — DynamoDB, S3, Cognito, CloudFront (OAC), API Gateway v2, 6 Lambda routes
- [x] `backend/functions/get-snippet.ts` — stub (501)
- [x] `backend/functions/submit-answer.ts` — stub (501)
- [x] `backend/functions/get-progress.ts` — stub (501)
- [x] `backend/functions/auth-session.ts` — stub (501)
- [x] `backend/functions/auth-refresh.ts` — stub (501)
- [x] `backend/functions/auth-logout.ts` — stub (501)
- [x] `backend/lib/dynamo-client.ts` — DocumentClient singleton
- [x] `backend/lib/cognito-client.ts` — CognitoIdentityProviderClient
- [x] `backend/lib/adaptive-difficulty.ts` — typed stubs
- [x] `frontend/` scaffold — Vite + React + TypeScript, HTTPS via mkcert
- [x] `scripts/requirements.txt`
- [x] `.gitignore`, `tsconfig.json`, `package.json`
- [x] `docs/runbook.md` — operational runbook

**Verification:** JWT routes → 401 without token; auth routes → 501. DynamoDB, S3, Cognito, CloudFront, API Gateway all deployed in eu-west-2.

**Deployed outputs (edoatley stage):**
- API: `https://0itsetefp0.execute-api.eu-west-2.amazonaws.com`
- Frontend: `https://d2f8i8wh2lqiqm.cloudfront.net`
- Cognito User Pool: `eu-west-2_VVP8q00KT`, Client ID: `76en7r4i4nrttptoov29gasjoh`
- Snippet CDN: `drcxs06o68yvn.cloudfront.net`
- DynamoDB table: `security-flaw-practice-app-edoatley-AppTableTable-cnsokcdd`
- Snippet bucket: `snippetbucket-c7b1918`

---

## Phase 2 — Auth Lambdas + Frontend Auth Flow ✅ COMPLETE

**Goal:** User can sign in via Cognito Hosted UI, land on `/game`, and stay authenticated across page reloads. Silent refresh works proactively.

**EARS specs:** AUTH-001–066

### Backend

- [x] `backend/functions/auth-session.ts` — sets `refresh_token` httpOnly cookie (`Path=/auth; SameSite=None; Secure; Max-Age=2592000`); returns `{ ok: true }`
- [x] `backend/functions/auth-refresh.ts` — reads cookie, POSTs to Cognito `/oauth2/token`, returns `{ access_token, expires_in }`; 401 on missing cookie or Cognito error
- [x] `backend/functions/auth-logout.ts` — best-effort revoke via Cognito `/oauth2/revoke`; clears cookie (`Max-Age=0`); always returns 200

### Frontend

- [x] `frontend/src/api/client.ts` — module-level access token; 15-s timeout; 401 → refresh → retry; thundering herd mutex; dispatches `SESSION_EXPIRED` window event
- [x] `frontend/src/auth/AuthProvider.tsx` — silent refresh on mount; proactive refresh at `(expires_in - 300)s`; `SESSION_EXPIRED` listener; `onLoginSuccess` / `logout`
- [x] `frontend/src/auth/useAuth.ts` — `useContext(AuthContext)` hook
- [x] `frontend/src/pages/LandingPage.tsx` — PKCE flow (SHA-256 challenge, sessionStorage verifier); redirects to Cognito Hosted UI
- [x] `frontend/src/pages/AuthCallbackPage.tsx` — validates state, handles `?error=`, exchanges code + verifier for tokens, calls `onLoginSuccess`, navigates to `/game`
- [x] `frontend/src/pages/GamePage.tsx` — placeholder with logout button
- [x] `frontend/src/pages/ProgressPage.tsx` — placeholder
- [x] `frontend/src/components/ProtectedRoute.tsx` — waits for `isLoading`, redirects to `/` if unauthenticated
- [x] `frontend/src/App.tsx` — BrowserRouter + AuthProvider + 4 routes
- [x] `frontend/src/types/index.ts` — `Tier`, `AuthTokens`
- [x] `frontend/vite.config.ts` — auto-detects mkcert certs for HTTPS

**Verification:** Sign in → `/game`; `refresh_token` cookie has `HttpOnly`, `Secure`, `SameSite=None`; page reload re-authenticates silently; logout clears cookie and redirects to `/`.

---

## Phase 3 — Core Game API + Snippet Seeder

**Goal:** Full playable round. API selects a snippet, frontend displays Java code with clickable lines, user submits and receives feedback. 3 test snippets seeded.

**EARS specs:** GAME-001–050, API-005–040, CONTENT-001–040, DIFF-001, DIFF-040–041

### Backend shared libs

- [x] `backend/lib/dynamo-client.ts` — complete (already done as singleton; verify `Resource.AppTable.name` binding works under sst dev)
- [x] `backend/lib/adaptive-difficulty.ts` — implement `computeCompositeScore` and `evaluateTierTransition` (pure functions, no I/O)

### Backend — GetSnippet (`GET /api/snippet`)

- [x] Extract `userId` from `event.requestContext.authorizer.jwt.claims.sub`
- [x] `GetItem` (strong) `PK=USER#<userId>` `SK=PROFILE` → lazy-create with `attribute_not_exists` guard; retry once on race
- [x] `Query` GSI `GSI1PK-GSI1SK-index` with `GSI1PK=DIFFICULTY#<tier>`, `Limit:200`; projection excludes `vulnerableLines` and `explanation`
- [x] `Query` last 5 attempts (`ScanIndexForward:false`, `Limit:5`) → exclusion set
- [x] If zero candidates → return `{ status: "TIER_COMPLETE", tier, canReset: true }` (HTTP 200)
- [x] Random pick after exclusion filter (fall back to full set if exclusion empties candidates)
- [x] Return `{ snippetId, contentUrl, title, owaspCategory, difficulty, lineCount, vulnerableLineCount }` where `contentUrl = https://${CLOUDFRONT_DOMAIN}/${snippet.contentKey}`

### Backend — SubmitAnswer (`POST /api/answer`)

- [x] Parse + validate body: `snippetId` (UUID), `selectedLines` (array of positive integers), `timeTakenMs` (non-negative integer) → 400 on failure
- [x] Clamp `timeTakenMs` to `[0, 600000]`
- [x] `Promise.all`: `GetItem` snippet (strong) + `GetItem` user profile (strong)
- [x] Post-fetch validation: each `selectedLine ≤ lineCount`; `selectedLines.length ≤ vulnerableLineCount` → 400
- [x] Set-equality correctness check (order-independent)
- [x] `Query` last 20 attempts filtered by `tierId = currentTier` AND `timestamp > lastTransitionTimestamp`; `GetItem` `CONFIG#SPEED_MEDIANS`
- [x] Compute composite score; evaluate tier transition
- [x] `TransactWriteItems`: PutItem attempt with `attribute_not_exists(PK) AND attribute_not_exists(SK)` condition + UpdateItem profile; return 409 `ALREADY_SUBMITTED` on condition failure
- [x] Return `{ correct, score, tierChange }`; include `vulnerableLines` + `explanation` **only when `correct === true`**

### Scripts — Snippet Seeder

- [x] `scripts/load_snippets.py` — CLI (`--snippets-dir`, `--bucket`, `--table`, `--profile`, `--region`, `--dry-run`); validate-all-first; idempotent upsert; exit codes 0/1/2
  - DynamoDB keys: `PK=SNIPPET#<uuid>`, `SK=METADATA`, `GSI1PK=DIFFICULTY#<difficulty>`, `GSI1SK=SNIPPET#<uuid>`
  - S3 key: `snippets/java/<difficulty_lowercase>/<snippetId>.java`
  - Also seed `CONFIG#ALGO_PARAMS/V0` and `CONFIG#SPEED_MEDIANS/V0` if not present
- [x] `scripts/snippets/metadata.json` — 3 initial snippets:
  - BEGINNER / `A03_INJECTION` — SQL injection via string concatenation
  - BEGINNER / `A03_INJECTION` — reflected XSS in servlet
  - INTERMEDIATE / `A05_SECURITY_MISCONFIGURATION` — XXE via unconfigured DocumentBuilder
- [x] `scripts/snippets/java/beginner/sql-injection.java`
- [x] `scripts/snippets/java/beginner/reflected-xss.java`
- [x] `scripts/snippets/java/intermediate/xxe-document-builder.java`

### Frontend — Full Game Loop

- [x] `frontend/src/pages/GamePage.tsx` — `useReducer` with states: `LOADING → PLAYING → SUBMITTING → RESULT → LOADING`
  - LOADING: `api.getSnippet()` → `fetch(contentUrl)` → split on `\n`; handle `TIER_COMPLETE`
  - PLAYING: `<CodeViewer>` + `<SelectionSummary>` + `<SubmitButton>`
  - SUBMITTING: overlay; Submit disabled
  - RESULT: annotated lines + `<ResultCard>`
- [x] `frontend/src/components/CodeViewer.tsx` — syntax-highlighted code; one `<LineRow>` per line; passes `visualState` per line
- [x] `frontend/src/components/LineRow.tsx` — clickable gutter + highlighted code; toggle on click; `user-select:none` on gutter; cap at `vulnerableLineCount`
- [x] `frontend/src/components/ResultCard.tsx` — shows `correct`, OWASP badge; `explanation` only when `correct === true`; "Try again" / "Next" button
- [x] `frontend/src/types/index.ts` — expand with `SnippetResponse`, `SubmitRequest`, `SubmitResponse`, `ProgressResponse`, line visual states

**Line visual states (6):** `correct`, `incorrect`, `missed`, `unselected` (RESULT phase); `selected`, `default` (PLAYING phase).

**Verification:**
- `python scripts/load_snippets.py --dry-run ...` exits 0
- Load 3 snippets; verify with AWS CLI
- `GET /api/snippet` returns `{ contentUrl, ... }`; `fetch(contentUrl)` returns Java source
- Submit correct → `{ correct: true, snippet: { vulnerableLines, explanation } }`
- Submit incorrect → `{ correct: false }` (no `snippet` key)
- Frontend displays Java code with syntax highlighting and all 6 visual states
- Line cap enforced client-side (inline message) and server-side (400)

---

## Phase 4 — Adaptive Difficulty + GetProgress

**Goal:** Difficulty tier changes correctly after sufficient attempts. Progress dashboard shows rolling score and tier estimates.

**EARS specs:** DIFF-002–043, API-041–043, GAME-046–063

### Backend — adaptive-difficulty.ts (complete implementation)

- [x] `computeCompositeScore(attempts, medians, params)`:
  - Per attempt: `rawSpeed = median(tier) / timeTakenMs`; clamp to `[0, 2]`; divide by 2 → `[0, 1]`; neutral 0.5 if `sampleSize < 100`
  - `correctRate = correctCount / windowSize`
  - `composite = params.correctRateWeight × correctRate + params.speedWeight × meanSpeedScore`
- [x] `evaluateTierTransition(tier, window20, window10, composite20, composite10, params)`:
  - Tier-up: `composite20 >= tierUpThreshold` and `window20.length === 20`
  - Tier-down: `composite10 < tierDownThreshold` and `window10.length === 10`
  - Check tier-up before tier-down; one step at a time
- [x] Config caching: both `CONFIG#ALGO_PARAMS` and `CONFIG#SPEED_MEDIANS` cached in Lambda module scope with 5-min TTL

### Backend — GetProgress (`GET /api/progress`)

- [x] `Promise.all`: profile (eventual) + last 20 attempts + `CONFIG#SPEED_MEDIANS`
- [x] 404 `USER_NOT_FOUND` if profile missing
- [x] Compute composite score via `computeCompositeScore`
- [x] Forward-simulate `attemptsUntilUpgrade` / `attemptsUntilDowngrade` (null at boundary tiers)
- [x] Return `{ currentTier, rollingScore, totalAttempts, correctAttempts, attemptsUntilUpgrade, attemptsUntilDowngrade, recentAttempts }`

### Frontend — Progress Dashboard

- [x] `frontend/src/pages/ProgressPage.tsx` — fetch `GET /api/progress` on mount; loading skeleton; `TierSummaryCard` + `AttemptHistoryTable`
- [x] `frontend/src/components/TierBadge.tsx` — tier badge inline in GamePage/ProgressPage (not extracted to separate component)
- [x] `frontend/src/components/ScoreBar.tsx` — visual rolling composite score bar (inline in ProgressPage)
- [x] `GamePage` tier change notification — inline banner in `ResultCard` after `SUBMIT_SUCCESS` if `tierChange.changed === true`

**Verification:**
- 20 consecutive correct BEGINNER answers → tier promotes to INTERMEDIATE in SubmitAnswer response
- `GET /api/progress` returns accurate composite score and `attemptsUntilUpgrade`
- Speed score defaults to 0.5 (neutral) when `sampleSize < 100`
- Tier drops after 10 low-scoring answers
- Progress page shows loading skeleton then real data

---

## Phase 5 — Frontend Polish + Error States

**Goal:** Complete, robust game experience. All error and edge states handled. No dead ends.

**EARS specs:** GAME-001–063 (complete), AUTH-023–049

### Frontend

- [x] `frontend/src/components/ErrorDisplay.tsx` — distinguishes timeout / 5xx / 4xx; Retry re-fetches snippet; Skip re-fetches without recording attempt
- [x] `frontend/src/components/GlobalErrorBoundary.tsx` — catches render errors; static fallback with Reload button
- [x] `frontend/src/components/TierCompleteCard.tsx` — "You've completed all X snippets"; link to progress dashboard
- [x] `AuthCallbackPage` — handle `?error=` from Cognito (user cancelled) → "Login failed" + retry link
- [x] `AuthCallbackPage` — CSRF state mismatch → redirect to `/`
- [x] `AuthCallbackPage` — `/auth/session` failure → allow session for access token lifetime (55 min) then require re-login
- [x] `SubmitButton` disabled after first click (client guard; backend `TransactWriteItems` is authoritative)
- [x] 409 response → "Already submitted" message (no crash; currently falls into generic ERROR state)
- [x] `SelectionSummary` at cap → "Maximum lines selected (N/N). Deselect a line to change your answer."
- [x] `ProtectedRoute` — awaits one `POST /auth/refresh` attempt before redirecting; shows blank during wait

**Verification:**
- ERROR state renders Retry and Skip; both work without losing game state
- TIER_COMPLETE renders without crash; progress link works
- Silent refresh invisible on page reload
- Tab left open 55 min continues working (proactive refresh fired at T-5)
- `GlobalErrorBoundary` catches synthetic render error; Reload works
- Double-click Submit → only one attempt record in DynamoDB

---

## Phase 6 — Production Hardening + Full Content ✅ COMPLETE

**Goal:** Live at `https://secure-train.edoatley.co.uk`. Security headers. 10+ snippets covering all OWASP Top 10 categories.

**EARS specs:** Remaining AUTH, DIFF, CONTENT specs — all 255 covered across phases 1–6.

### Infrastructure (`sst.config.ts`)

- [x] Custom domain: `secure-train.edoatley.co.uk` (SPA) — production URLs already wired in `sst.config.ts`; DNS/certificate setup required on first production deploy
- [x] CloudFront Response Headers Policy on SPA: CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `XSS-Protection` — `SpaSecurityHeaders` policy via `transform.cdn`
- [x] `forceDestroy: false` on snippet bucket for production (currently `!isProd` ✓)

**CSP (production):**
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' https://sfpa-793976-production.auth.eu-west-2.amazoncognito.com
  https://api.secure-train.edoatley.co.uk https://content.secure-train.edoatley.co.uk;
object-src 'none'; frame-ancestors 'none'
```

### Backend — ComputeMedians Lambda

- [x] `backend/functions/compute-medians.ts` — EventBridge daily schedule via `sst.aws.Cron`
  - Scans Attempt records; groups by `tierId`; filters `timeTakenMs` to `[3000, 600000]`; writes `CONFIG#SPEED_MEDIANS/V0`

### Snippet content (11 snippets — all OWASP Top 10 categories covered)

- [x] BEGINNER / `A01_BROKEN_ACCESS_CONTROL` — IDOR via request param
- [x] BEGINNER / `A03_INJECTION` — SQL injection string concat (Phase 3)
- [x] BEGINNER / `A03_INJECTION` — Reflected XSS in servlet (Phase 3)
- [x] BEGINNER / `A07_IDENTIFICATION_AND_AUTHENTICATION_FAILURES` — hardcoded admin password
- [x] INTERMEDIATE / `A02_CRYPTOGRAPHIC_FAILURES` — MD5 password hashing
- [x] INTERMEDIATE / `A05_SECURITY_MISCONFIGURATION` — XXE unconfigured DocumentBuilder (Phase 3)
- [x] INTERMEDIATE / `A08_SOFTWARE_AND_DATA_INTEGRITY_FAILURES` — unsafe Java deserialization
- [x] INTERMEDIATE / `A09_SECURITY_LOGGING_AND_MONITORING_FAILURES` — password logged at INFO
- [x] ADVANCED / `A04_INSECURE_DESIGN` — race condition in balance transfer
- [x] ADVANCED / `A06_VULNERABLE_AND_OUTDATED_COMPONENTS` — Log4Shell pattern
- [x] ADVANCED / `A10_SERVER_SIDE_REQUEST_FORGERY` — SSRF via URL parameter

### Production deploy sequence

1. [ ] `AWS_PROFILE=sandbox npx sst deploy --stage production`
2. [ ] Note SPA CloudFront URL from SST outputs
3. [ ] Update `callbackUrls` for production in `sst.config.ts` to `https://secure-train.edoatley.co.uk/auth/callback`
4. [ ] `AWS_PROFILE=sandbox npx sst deploy --stage production` (second pass)
5. [ ] `AWS_PROFILE=sandbox python scripts/load_snippets.py --bucket <prod-bucket> --table <prod-table> --region eu-west-2`

**Verification:**
- `https://secure-train.edoatley.co.uk` loads; login works end-to-end
- `curl -I https://secure-train.edoatley.co.uk` shows all 6 security headers
- No CSP violations in browser console during normal use
- All 11 snippets playable; each OWASP category appears at least once
- `sst remove --stage production` does NOT delete snippet bucket
- `ComputeMedians` invocable manually; updates `CONFIG#SPEED_MEDIANS` in DynamoDB

---

## Critical Files Reference

| File | Phase | Notes |
|---|---|---|
| `sst.config.ts` | 1 | Bootstrap ordering, circular references, CloudFront OAC |
| `backend/functions/submit-answer.ts` | 3 | Highest complexity — TransactWriteItems, tier eval, answer redaction |
| `backend/lib/adaptive-difficulty.ts` | 3/4 | Pure functions — must produce identical scores in SubmitAnswer and GetProgress |
| `frontend/src/auth/AuthProvider.tsx` | 2 | Security-critical — token storage, refresh mutex, XSS surface |
| `scripts/load_snippets.py` | 3 | Validate-all-first; idempotent; exit codes 0/1/2 |
| `backend/functions/get-snippet.ts` | 3 | CloudFront domain bootstrap dependency |

## Key Data Format Decisions

These resolve conflicts between design documents — apply consistently everywhere:

| Decision | Value |
|---|---|
| `owaspCategory` format | `A03_INJECTION` (underscore-enum, not OWASP colon notation) |
| S3 key format | `snippets/java/<difficulty_lowercase>/<snippetId>.java` |
| Attempt SK | `ATTEMPT#<ISO-8601>#<snippetId>` (snippetId, not random UUID — required for deduplication) |
| `timeTakenMs` cap | 600,000 ms (10 min); zero accepted |
| DynamoDB snippet keys | `PK=SNIPPET#<uuid>` / `SK=METADATA` |
| CONFIG item keys | `PK=CONFIG#SPEED_MEDIANS` / `SK=V0` and `PK=CONFIG#ALGO_PARAMS` / `SK=V0` |
| Explanation + `vulnerableLines` | Returned **only on correct submission** |
