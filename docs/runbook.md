# Runbook: Security Flaw Practice App

Operational reference for spinning up, developing, and tearing down the platform.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22+ | `brew install node` |
| AWS CLI | 2.x | `brew install awscli` |
| Python | 3.10+ | `brew install python` |
| mkcert | any | `brew install mkcert` |

**AWS profile:** All commands require `AWS_PROFILE=sandbox`. The default AWS profile targets a different account and will not work.

```bash
export AWS_PROFILE=sandbox   # add to shell profile to avoid repeating
```

---

## First-Time Setup

```bash
# 1. Install root dependencies (SST + AWS SDK)
npm install

# 2. Install frontend dependencies
cd frontend && npm install && cd ..

# 3. Install Python snippet-loader dependencies
cd scripts && pip install -r requirements.txt && cd ..

# 4. Generate local HTTPS certs (one-time per machine)
mkcert -install
mkcert localhost
# Generates localhost.pem and localhost-key.pem in project root (git-ignored)
# Vite auto-detects these — no config change needed
```

---

## Deploy to a Personal Stage

Each developer should use their own stage name (e.g. your first name) to avoid resource conflicts.

```bash
AWS_PROFILE=sandbox npx sst deploy --stage <your-name>
```

SST prints outputs on completion:

```
Api:    https://<id>.execute-api.eu-west-2.amazonaws.com
Web:    https://<id>.cloudfront.net
---
apiUrl:            https://...
cognitoUserPoolId: eu-west-2_Xxxxx
cognitoClientId:   xxxxxxxxxxxxxxx
snippetBucket:     snippetbucket-xxxxx
snippetCdnDomain:  xxxxx.cloudfront.net
tableName:         security-flaw-practice-app-<stage>-AppTableTable-xxxxx
```

Save these — you'll need them for the snippet loader and for creating test users.

**Cognito callback URLs:** Non-production stages register both `https://localhost:5173/auth/callback` and `https://<stage>.secure-train.edoatley.co.uk/auth/callback`. The local Vite dev server always uses the localhost URL.

**Cognito domain note:** The Hosted UI domain prefix `sfpa-793976-<stage>` must be globally unique across all AWS accounts. If you see `Domain already associated with another user pool`, choose a different stage name.

---

## Create a Test User

After deploying, create a user in Cognito to sign in with:

```bash
# Create the user (email_verified=true skips the verification email)
AWS_PROFILE=sandbox aws cognito-idp admin-create-user \
  --user-pool-id <cognitoUserPoolId from outputs> \
  --username <your-email> \
  --user-attributes Name=email,Value=<your-email> Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region eu-west-2

# Set a permanent password (avoids FORCE_CHANGE_PASSWORD state)
AWS_PROFILE=sandbox aws cognito-idp admin-set-user-password \
  --user-pool-id <cognitoUserPoolId from outputs> \
  --username <your-email> \
  --password '<YourPassword>' \
  --permanent \
  --region eu-west-2
```

Cognito passwords must be at least 8 characters and include uppercase, lowercase, a number, and a special character.

---

## Local Development

Local dev runs Lambda functions in AWS but serves the frontend from `https://localhost:5173`.

```bash
AWS_PROFILE=sandbox npx sst dev --mode=basic
```

`--mode=basic` is required — the default TUI crashes on some terminals (known SST issue). In a second terminal, start Vite:

```bash
cd frontend && npm run dev
```

The frontend will be at `https://localhost:5173` (HTTPS is required for `SameSite=Strict` cookies). mkcert certs must be present — see First-Time Setup.

---

## Load Snippet Content

After deploying, seed the DynamoDB and S3 snippet bucket with test content:

```bash
cd scripts

# Dry run first (validates metadata, no AWS calls)
python load_snippets.py \
  --snippets-dir snippets/ \
  --bucket <snippetBucket from outputs> \
  --table <tableName from outputs> \
  --region eu-west-2 \
  --profile sandbox \
  --dry-run

# Load for real
python load_snippets.py \
  --snippets-dir snippets/ \
  --bucket <snippetBucket from outputs> \
  --table <tableName from outputs> \
  --region eu-west-2 \
  --profile sandbox
```

The script is idempotent — safe to re-run. Exit codes: 0 = all succeeded, 1 = validation/arg error, 2 = partial write failures.

The script also seeds two DynamoDB config items if they don't already exist:
- `CONFIG#ALGO_PARAMS/V0` — tier-up/down thresholds and window sizes
- `CONFIG#SPEED_MEDIANS/V0` — per-tier timing medians (initialised to null; populated by the offline `ComputeMedians` Lambda in Phase 6)

Until `ComputeMedians` has run with ≥ 100 samples per tier, speed scores default to `0.5` (neutral), so the composite score reduces to `0.70 × correctRate + 0.30 × 0.5 = 0.70 × correctRate + 0.15`.

---

## Verify Phase 3 (Game API)

After seeding snippets, verify the game API end-to-end:

```bash
# Set your stage outputs
API="https://0itsetefp0.execute-api.eu-west-2.amazonaws.com"   # or your stage API URL

# 1. Verify GetSnippet returns a snippet (requires a valid JWT from a browser session)
curl -s -H "Authorization: Bearer <JWT>" "$API/api/snippet" | jq .

# 2. Verify snippet file is reachable from the contentUrl returned above
curl -s "<contentUrl from above>"

# 3. Submit a correct answer for SQL injection (snippetId a3f1c2d4-..., vulnerable lines 17 and 18)
curl -s -X POST "$API/api/answer" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"snippetId":"a3f1c2d4-1234-4abc-8def-000000000001","selectedLines":[17,18],"timeTakenMs":30000}' | jq .
# Expect: correct=true, snippet.vulnerableLines=[17,18]

# 4. Submit an incorrect answer and confirm explanation is withheld
curl -s -X POST "$API/api/answer" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"snippetId":"b4e2d3f5-2345-4bcd-9ef0-000000000002","selectedLines":[10],"timeTakenMs":15000}' | jq .
# Expect: correct=false, no "snippet" key in response

# 5. Verify progress endpoint
curl -s -H "Authorization: Bearer <JWT>" "$API/api/progress" | jq .
```

---

## Tear Down a Stage

```bash
AWS_PROFILE=sandbox npx sst remove --stage <your-name>
```

**This deletes all resources including the snippet bucket and its contents** (`forceDestroy=true` for non-production stages). You will need to re-seed after removing and redeploying.

**Never run `sst remove --stage production`.** The production stage uses `removal: "retain"` but the snippet bucket policy and Cognito pool may still be affected.

---

## Stage Reference

| Stage | Purpose | Snippet bucket |
|---|---|---|
| `<your-name>` | Personal development | Deleted on `sst remove` |
| `production` | Live site at `secure-train.edoatley.co.uk` | Retained on `sst remove` |

---

## Known Issues / Gotchas

**Cognito domain prefix is globally unique across all AWS accounts.**
The prefix `sfpa-793976-<stage>` is hardcoded in `sst.config.ts`. If another AWS account has already claimed the same prefix, deployment fails with `Domain already associated with another user pool`. This happened during initial setup when the wrong account was used — the `793976` segment makes it account-specific.

**New Cognito users start in FORCE_CHANGE_PASSWORD state.**
`admin-create-user` always creates users needing a password reset, which blocks the Hosted UI login flow. Always follow up with `admin-set-user-password --permanent` immediately after creation (see Create a Test User above).

**`sst dev` TUI crash.**
Running `npx sst dev` without `--mode=basic` causes a segfault in some terminals (`tcell` library nil pointer). Always use `--mode=basic`.

**`sst dev` leaves a stale lock if killed.**
If `sst dev` is interrupted (Ctrl+C, crash), it may leave a deployment lock. Run `AWS_PROFILE=sandbox npx sst unlock` before the next deploy.

**`sst dev --mode=basic` fails with "appsync connection failed".**
SST stores an AppSync WebSocket endpoint in its deployment state from certain prior SST versions. If that AppSync API no longer exists (or was never created), `sst dev` exits immediately with `Unexpected error occurred`. Fix: run `AWS_PROFILE=sandbox npx sst deploy --stage <your-name>` once to reconcile state, then `sst dev --mode=basic` will work normally.

**CloudFront snippet domain bootstrapping (Phase 3+).**
`GetSnippet` Lambda needs the `CLOUDFRONT_DOMAIN` env var but this value is only known after first deploy. After deploying, check SST outputs for `snippetCdnDomain` and confirm it matches what's injected into the Lambda environment. This is handled automatically by `sst.config.ts` via Pulumi outputs.

**mkcert certs not found.**
If Vite starts on `http://` instead of `https://`, the `SameSite=None; Secure` cookie will be blocked and auth won't work. Check that `localhost.pem` and `localhost-key.pem` exist in the project root. The `mkcert -install` step requires sudo and a terminal (cannot be run from a script).

**Refresh token cookie requires `SameSite=None` in local dev.**
In production, the frontend and API share the same apex domain (`secure-train.edoatley.co.uk`), so a `SameSite=Strict` cookie would work. In local dev the API is on `execute-api.amazonaws.com` — a different origin — so the cookie is set with `SameSite=None; Secure` to allow the cross-origin credential flow. Vite's HTTPS (mkcert) satisfies the `Secure` requirement.

**`SESSION_EXPIRED` race condition on initial load.**
`AuthProvider` fires a silent `refreshTokens(true)` on startup. The `silent=true` flag suppresses the `SESSION_EXPIRED` event so a failed startup refresh (no cookie yet) does not clobber the access token that `AuthCallbackPage` writes after a successful PKCE exchange.

**Wrong AWS account.**
Always verify you're in the sandbox account before deploying:
```bash
aws sts get-caller-identity --profile sandbox
# Should show Account: 793976186123
```

**Callback URL mismatch.**
Cognito will reject the auth flow with `redirect_mismatch` if the URL sent by the frontend isn't registered on the client. Non-production stages register both localhost and the deployed CloudFront URL. If you add a new stage, the deploy will register its URL automatically — no manual Cognito console changes needed.
