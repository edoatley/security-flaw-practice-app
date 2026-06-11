# Security Flaw Practice App

A gamified, web-based platform for learning to identify security vulnerabilities in Java code. Users are shown real-looking code snippets and must click the vulnerable line(s) to identify the flaw. The platform provides OWASP-categorised feedback and adapts difficulty based on performance history.

## Features

- **Interactive code review** — click line numbers to select vulnerable lines in syntax-highlighted Java
- **OWASP Top 10 coverage** — 11 snippets spanning all OWASP Top 10 categories at launch
- **Adaptive difficulty** — three tiers (Beginner, Intermediate, Advanced) with automatic promotion/demotion based on a composite score of accuracy and speed
- **Secure by design** — the answer key is never sent to the client on incorrect submissions; access tokens are stored in memory only
- **Progress dashboard** — rolling composite score, tier estimates, and attempt history

## Architecture

| Layer | Technology |
|---|---|
| Infrastructure | SST v4 (Pulumi-based TypeScript DSL), AWS eu-west-2 |
| Frontend | React + Vite SPA, hosted on S3 + CloudFront |
| API | API Gateway v2 + AWS Lambda (Node.js 22, arm64) |
| Database | DynamoDB single-table design |
| Snippet storage | S3 + CloudFront (separate distribution, Origin Access Control) |
| Auth | Cognito User Pool + Hosted UI, PKCE flow |

See `docs/high-level-design.md` for a full architecture overview.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22+ |
| AWS CLI | 2.x |
| Python | 3.10+ |
| mkcert | any |

You also need an AWS account with SST-compatible permissions and a configured AWS CLI profile.

## Local Development Setup

### 1. Install dependencies

```bash
npm install
cd frontend && npm install && cd ..
cd scripts && pip install -r requirements.txt && cd ..
```

### 2. Set up local HTTPS (one-time per machine)

```bash
mkcert -install
mkcert localhost
```

This generates `localhost.pem` and `localhost-key.pem` in the project root (already git-ignored). Vite auto-detects these.

### 3. Configure your AWS profile

```bash
export AWS_PROFILE=<your-aws-profile>
```

### 4. Deploy to a personal stage

```bash
npx sst deploy --stage <your-name>
```

SST prints the outputs (API URL, CloudFront URL, Cognito pool details) when the deploy completes.

### 5. Create a test user

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <pool-id> \
  --username <your-email> \
  --region eu-west-2

aws cognito-idp admin-set-user-password \
  --user-pool-id <pool-id> \
  --username <your-email> \
  --password <password> \
  --permanent \
  --region eu-west-2
```

### 6. Create the frontend env file

```bash
cp frontend/.env.local.example frontend/.env.local
# Edit the values using the SST deploy outputs
```

### 7. Seed snippets

```bash
cd scripts
python load_snippets.py \
  --snippets-dir snippets/ \
  --bucket <snippet-bucket-name> \
  --table <dynamodb-table-name> \
  --region eu-west-2
```

### 8. Start the dev server

```bash
cd frontend && npm run dev
```

The frontend is available at `https://localhost:5173`. Lambda functions run in AWS (SST live dev mode). Run `npx sst dev` in a separate terminal for live Lambda reloading.

## Project Structure

```
sst.config.ts               # All AWS infrastructure
package.json                # Root: SST only
backend/
  functions/                # One file per Lambda handler
  lib/                      # Shared utilities (dynamo-client, cognito-client, adaptive-difficulty)
frontend/
  package.json
  src/
    api/                    # API client (JWT attachment, 401 refresh)
    auth/                   # AuthProvider, PKCE flow, token storage
    components/             # Shared UI components
    pages/                  # GamePage, ProgressPage, CallbackPage
scripts/
  load_snippets.py          # Offline snippet seeder
  snippets/
    metadata.json           # Snippet metadata and answer keys
    java/                   # Raw .java snippet files by difficulty tier
docs/
  high-level-design.md      # System architecture
  llds/                     # Detailed design documents per component
  specs/                    # EARS requirements
  runbook.md                # Operational reference
```

## Lambda API

| Function | Route | Auth |
|---|---|---|
| GetSnippet | `GET /api/snippet` | JWT required |
| SubmitAnswer | `POST /api/answer` | JWT required |
| GetProgress | `GET /api/progress` | JWT required |
| AuthSession | `POST /auth/session` | None |
| AuthRefresh | `POST /auth/refresh` | None |
| AuthLogout | `POST /auth/logout` | None |

## Key Design Decisions

- **Answer key protection** — `vulnerableLines` and `explanation` are returned only on a correct submission
- **JWT storage** — access token in memory; refresh token in an `httpOnly; Secure; SameSite=None` cookie set by the `AuthSession` Lambda
- **Double-submit defence** — `SubmitAnswer` uses `TransactWriteItems` with a condition expression; returns `409` on duplicate
- **Adaptive difficulty** — composite score = 70% correct rate + 30% speed, computed over a rolling 20-attempt window; thresholds externalised to a DynamoDB config item

## Tearing Down

```bash
npx sst remove --stage <your-name>
```

This deletes all resources for your stage. The snippet bucket uses `forceDestroy: true` on non-production stages, so all seeded content is also removed — re-seed after a remove.

## Documentation

| Document | Location |
|---|---|
| Product requirements | `docs/PRD.md` |
| High-level architecture | `docs/high-level-design.md` |
| Data model | `docs/llds/data-model.md` |
| API contracts | `docs/llds/api.md` |
| Adaptive difficulty algorithm | `docs/llds/adaptive-difficulty.md` |
| Frontend design | `docs/llds/frontend.md` |
| Snippet loader | `docs/llds/snippet-loader.md` |
| Infrastructure | `docs/llds/sst-infrastructure.md` |
| Operational runbook | `docs/runbook.md` |

## Security Notes

This is a security education platform. The codebase itself is intentionally hardened:

- Security headers (CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`) enforced at CloudFront
- No secrets in version control — all runtime config via environment variables and SST resource bindings
- Cognito PKCE flow; no client secret stored in the browser

## Not Yet Implemented

These features are explicitly deferred from v1. They are documented as non-goals in `docs/high-level-design.md` and as alternatives/deferrals in the LLDs.

### Authentication & Users

- **Social / federated login** — GitHub, Google OAuth via Cognito identity federation
- **Progress reset** — `DELETE /api/progress/tier` endpoint; the `TIER_COMPLETE` screen offers a Reset button that is currently non-functional

### Game Mechanics

- **Partial credit** — incorrect submissions currently score 0 regardless of how many lines were correctly identified; per-line scoring is deferred to v2
- **Shift-click multi-line selection** — users currently click individual line numbers; shift-click range selection is deferred
- **Snippet repeat prevention** — the exclusion window is last-5 attempts only; a full "seen all snippets" shuffle/exhaustion mode is not implemented
- **Server-side answer timing** — `timeTakenMs` is client-reported and clamped; recording delivery timestamp server-side for tamper-proof timing is deferred to v2

### Content

- **Multi-language snippets** — Java only at launch; Python, JavaScript, Go support deferred
- **Multiple vulnerabilities per snippet** — each snippet currently has one logical vulnerability; multi-flaw snippets are deferred
- **Admin snippet authoring UI** — snippets are loaded via the offline Python script; a web UI for content authors is deferred
- **Community-contributed snippets** — user submission and moderation pipeline not designed

### Platform

- **Real-time leaderboards** — multiplayer / competitive mode deferred
- **Mobile-native app** — the SPA is responsive but there is no dedicated iOS/Android app
- **WAF rate limiting** — per-route throttling and abuse detection via AWS WAF are not configured at launch
- **Attempt history retention policy** — attempt records grow indefinitely; a TTL or archival strategy is not yet defined
