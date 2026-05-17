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

Each developer should use their own stage name to avoid conflicts.

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

Save these — you'll need them for the snippet loader.

**Cognito domain note:** The Hosted UI domain prefix `sfpa-793976-<stage>` must be globally unique across all AWS accounts. If you see `Domain already associated with another user pool`, choose a different stage name or contact the team to check for conflicts.

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

The script is idempotent — safe to re-run. Exit codes: 0 = success, 1 = AWS error, 2 = validation error.

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

**`sst dev` TUI crash.**
Running `npx sst dev` without `--mode=basic` causes a segfault in some terminals (`tcell` library nil pointer). Always use `--mode=basic`.

**CloudFront snippet domain bootstrapping (Phase 3+).**
`GetSnippet` Lambda needs the `CLOUDFRONT_DOMAIN` env var but this value is only known after first deploy. After deploying, check SST outputs for `snippetCdnDomain` and confirm it matches what's injected into the Lambda environment. This is handled automatically by `sst.config.ts` via Pulumi outputs.

**mkcert certs not found.**
If Vite starts on `http://` instead of `https://`, the `SameSite=Strict` cookie will be blocked and auth won't work. Check that `localhost.pem` and `localhost-key.pem` exist in the project root.

**Wrong AWS account.**
Always verify you're in the sandbox account before deploying:
```bash
aws sts get-caller-identity --profile sandbox
# Should show Account: 793976186123
```
