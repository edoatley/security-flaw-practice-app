# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A gamified, web-based **vulnerability identification and education platform**. Users are shown Java code snippets (some containing a security flaw, some not) and must click the vulnerable line(s) to identify them. The platform provides OWASP-categorised feedback and adapts difficulty based on the user's performance history.

Full product requirements: `docs/PRD.md`. Architecture decisions: `docs/high-level-design.md`.

## Development Workflow: Linked-Intent Development (LID)

This project uses the **linked-intent-dev** skill for all significant changes. The intent chain is:

```
HLD → LLDs → EARS specs → Tests → Code
```

**Before writing any code for a feature:**
1. Check `docs/high-level-design.md` exists and covers the feature
2. Check `docs/llds/` for a relevant LLD
3. Check `docs/specs/` for EARS requirements
4. If any are missing or stale, update them before touching code

For bug fixes and small changes, verify coherence (do the specs, tests, and code agree?) but skip creating new documents.

Invoke `/linked-intent-dev:linked-intent-dev` to start or resume a design phase.

## Architecture

### Stack

| Layer | Technology |
|---|---|
| Infrastructure | SST v4 (`sst.config.ts`) — Pulumi-based, TypeScript DSL |
| Frontend | React + Vite SPA, hosted on S3 + CloudFront |
| API | API Gateway v2 (HTTP API) + AWS Lambda (Node.js 22, arm64) |
| Database | DynamoDB single-table design |
| Snippet content | S3 + CloudFront (separate distribution from SPA) |
| Auth | Cognito User Pool + Hosted UI, PKCE flow |

### Project Structure

```
sst.config.ts               # All AWS infrastructure (single source of truth)
package.json                # Root: SST only
backend/
  functions/                # One file per Lambda handler
    get-snippet.ts          # GET /api/snippet
    submit-answer.ts        # POST /api/answer
    get-progress.ts         # GET /api/progress
    auth-session.ts         # POST /auth/session (sets httpOnly refresh cookie)
    auth-refresh.ts         # POST /auth/refresh (exchanges cookie for access token)
  lib/                      # Shared backend utilities (bundled per function by esbuild)
    dynamo-client.ts
    cognito-client.ts
    adaptive-difficulty.ts
frontend/
  package.json              # Frontend deps managed separately
  src/
    api/                    # API client (attaches JWT, handles 401 refresh)
    auth/                   # AuthProvider, PKCE flow, token storage
    components/             # Shared UI
    pages/                  # GamePage, ProgressPage, CallbackPage
scripts/
  load_snippets.py          # Python snippet seeder (offline, not deployed)
  snippets/
    metadata.json           # Snippet metadata + answer keys
    java/beginner/          # Raw .java files
    java/intermediate/
    java/advanced/
docs/
  PRD.md
  high-level-design.md
  llds/                     # One LLD per major component
  specs/                    # EARS requirements (created in Phase 3)
  planning/                 # Implementation plans (created in Phase 4)
```

### Lambda Functions

All five functions are registered in `sst.config.ts`. The three game functions require a Cognito JWT authorizer; the two auth functions do not.

| Function | Route | Auth |
|---|---|---|
| `GetSnippet` | `GET /api/snippet` | JWT required |
| `SubmitAnswer` | `POST /api/answer` | JWT required |
| `GetProgress` | `GET /api/progress` | JWT required |
| `AuthSession` | `POST /auth/session` | None |
| `AuthRefresh` | `POST /auth/refresh` | None |
| `AuthLogout` | `POST /auth/logout` | None |

### Key Design Decisions

- **JWT storage:** access token in memory only; refresh token in httpOnly cookie (`Path=/auth; SameSite=Strict; Secure`) set by `AuthSession` Lambda
- **Custom domain:** production runs on `secure-train.edoatley.co.uk` (SPA) and `api.secure-train.edoatley.co.uk` (API) — same apex domain required for `SameSite=Strict` cookies to work
- **Local dev HTTPS:** Vite serves on `https://localhost:5173` via `mkcert` — run `mkcert -install && mkcert localhost` once per machine; cert files are git-ignored
- **Answer keys** (`vulnerableLines`, `explanation`) returned only on a *correct* submission — omitted from incorrect submission responses; never sent by `GetSnippet`
- **Snippet content** served from S3 via a dedicated CloudFront distribution (not the SPA's CDN); Lambda returns a URL, not the content
- **Adaptive difficulty:** composite score (70% correct rate + 30% speed) over a rolling window of 20 attempts; all thresholds externalised to DynamoDB `CONFIG#ALGO_PARAMS` item
- **`TIER_COMPLETE`:** when a user exhausts all snippets at their tier, `GetSnippet` returns `{ status: "TIER_COMPLETE" }` — no fallback to another tier
- **Double-submit defence:** `SubmitAnswer` uses a `ConditionExpression` on the attempt `PutItem` inside a `TransactWriteItems`; returns `409` on duplicate

## Commands

### SST / Infrastructure

```bash
# Live dev (real AWS resources, frontend on localhost:5173)
npx sst dev

# Deploy to a personal stage
npx sst deploy --stage <your-name>

# Tear down a stage (non-production only — production uses removal: "retain")
npx sst remove --stage <your-name>
```

### Frontend (run from `frontend/`)

```bash
npm install
npm run dev      # Vite dev server on localhost:5173
npm run build    # Output to frontend/dist/
```

### Backend

No separate build step. SST bundles Lambda handlers via esbuild on `sst dev` / `sst deploy`.

### Snippet Loader (Python)

```bash
cd scripts
pip install boto3
python load_snippets.py \
  --snippets-dir snippets/ \
  --bucket <bucket-name> \
  --table <table-name> \
  --region eu-west-1 \
  [--dry-run]
```

The script validates all entries before writing anything. It is idempotent (upsert semantics).

## Stage Behaviour

| Stage | Resource removal | CORS origins | Notes |
|---|---|---|---|
| `sst dev` | — | `localhost:5173` | Lambdas run in AWS; frontend local |
| personal | `remove` | localhost or deployed URL | Named personal stage |
| `production` | `retain` | CloudFront URL only | Must not be accidentally removed |

## Key Constraints

- `tsconfig.json` is intentionally empty (`{}`); SST/esbuild owns TypeScript compilation
- `.sst/` is git-ignored — generated platform code, never edit manually
- The snippet bucket has `forceDestroy: true` for non-production stages; this means `sst remove` deletes all snippet objects — re-seed after remove
- Cognito callback URLs require the CloudFront URL, which creates a bootstrapping dependency on first deploy (see `docs/llds/sst-infrastructure.md` §8)
- `VITE_*` env vars are baked into the frontend build at deploy time by SST; infra changes that alter these values require a frontend redeploy

## Design Documents

| Document | Location | Covers |
|---|---|---|
| PRD | `docs/PRD.md` | Product requirements |
| HLD | `docs/high-level-design.md` | System architecture, key decisions |
| Data Model LLD | `docs/llds/data-model.md` | DynamoDB single-table schema, GSIs, S3 layout |
| API LLD | `docs/llds/api.md` | Lambda request/response contracts, validation |
| Adaptive Difficulty LLD | `docs/llds/adaptive-difficulty.md` | Scoring algorithm, tier transitions |
| Frontend LLD | `docs/llds/frontend.md` | Component tree, auth flow, game loop state machine |
| Snippet Loader LLD | `docs/llds/snippet-loader.md` | Python script design, `metadata.json` schema |
| SST Infrastructure LLD | `docs/llds/sst-infrastructure.md` | `sst.config.ts` structure, resource definitions, project layout |
