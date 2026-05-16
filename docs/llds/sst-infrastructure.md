# Low-Level Design: SST Infrastructure & Project Structure

**Component:** SST v4 Infrastructure-as-Code & Repository Layout
**Version:** 0.1 (Draft)
**Date:** 2026-05-16
**Status:** Draft
**Parent HLD:** [high-level-design.md](../high-level-design.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Project Directory Structure](#2-project-directory-structure)
3. [SST Resource Definitions](#3-sst-resource-definitions)
4. [Lambda Function Configuration](#4-lambda-function-configuration)
5. [Environment Variables & Linking](#5-environment-variables--linking)
6. [Stage Strategy](#6-stage-strategy)
7. [Decisions & Alternatives](#7-decisions--alternatives)
8. [Edge Case Probe](#8-edge-case-probe)

---

## 1. Overview

SST v4 is the infrastructure-as-code layer for this project. It uses a Pulumi-based engine under the hood but exposes a TypeScript DSL (`sst.config.ts`) for defining AWS resources. SST handles bundling Lambda functions via esbuild, deploying static sites to S3+CloudFront, and wiring environment variables between resources automatically.

The root `sst.config.ts` is the single source of truth for all AWS infrastructure. No CDK, CloudFormation, or Terraform files exist alongside it.

---

## 2. Project Directory Structure

```
security-flaw-practice-app/
│
├── sst.config.ts                  # All AWS infrastructure definitions
├── package.json                   # Root: SST dependency only
├── tsconfig.json                  # Minimal (SST handles TS compilation)
│
├── backend/                       # Lambda function handlers (TypeScript)
│   ├── functions/
│   │   ├── get-snippet.ts         # GET /api/snippet
│   │   ├── submit-answer.ts       # POST /api/answer
│   │   ├── get-progress.ts        # GET /api/progress
│   │   ├── auth-session.ts        # POST /auth/session
│   │   ├── auth-refresh.ts        # POST /auth/refresh
│   │   └── auth-logout.ts         # POST /auth/logout
│   └── lib/                       # Shared backend utilities
│       ├── dynamo-client.ts        # DocumentClient singleton
│       ├── cognito-client.ts       # Cognito IdP client (auth functions only)
│       └── adaptive-difficulty.ts  # Rolling window score computation
│
├── frontend/                      # React SPA (Vite)
│   ├── package.json               # Frontend deps (React, Vite, etc.)
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/                   # API client module
│       ├── auth/                  # AuthProvider, auth flow
│       ├── components/            # Shared UI components
│       ├── pages/                 # GamePage, ProgressPage, CallbackPage
│       └── types/                 # Shared TypeScript types
│
├── scripts/                       # Offline tooling (not deployed)
│   ├── load_snippets.py           # Snippet seeder (Python + boto3)
│   └── snippets/                  # Source snippet content
│       ├── metadata.json          # Snippet metadata + answer keys
│       └── java/                  # Raw .java files, named by snippetId
│           ├── beginner/
│           ├── intermediate/
│           └── advanced/
│
└── docs/                          # Design documentation
    ├── PRD.md
    ├── high-level-design.md
    └── llds/
        ├── sst-infrastructure.md  # This document
        ├── data-model.md
        ├── api.md
        ├── adaptive-difficulty.md
        ├── frontend.md
        └── snippet-loader.md
```

### Key layout decisions

- **`backend/functions/`** — one file per Lambda handler. SST's esbuild bundler treats each file as a separate entry point; sharing code via `backend/lib/` is straightforward because esbuild resolves relative imports at bundle time.
- **`backend/lib/`** — shared utilities bundled into each Lambda that imports them. No Lambda layer needed; esbuild tree-shakes unused exports.
- **`frontend/`** — fully self-contained with its own `package.json`. The root `package.json` does not list any frontend dependencies.
- **`scripts/`** — Python tooling kept separate from deployed code. Never imported by Lambda handlers.

---

## 3. SST Resource Definitions

All resources are declared in `sst.config.ts` inside the `run()` function. Resources are defined in dependency order (SST resolves the Pulumi DAG automatically, but explicit ordering improves readability).

### 3.1 DynamoDB Table

```typescript
const table = new sst.aws.Dynamo("AppTable", {
  fields: {
    PK: "string",
    SK: "string",
    GSI1PK: "string",
    GSI1SK: "string",
  },
  primaryIndex: { hashKey: "PK", rangeKey: "SK" },
  globalIndexes: {
    "GSI1PK-GSI1SK-index": { hashKey: "GSI1PK", rangeKey: "GSI1SK" },
  },
  // Billing: on-demand (PAY_PER_REQUEST) — no capacity planning at launch
});
```

### 3.2 S3 Snippet Content Bucket

SST does not have a dedicated S3 construct for non-website buckets in v4; use the AWS provider directly via `$aws`:

```typescript
const snippetBucket = new aws.s3.BucketV2("SnippetBucket", {
  forceDestroy: true, // allows sst remove to clean up even if objects exist
});

// Block all public access
new aws.s3.BucketPublicAccessBlock("SnippetBucketPublicAccessBlock", {
  bucket: snippetBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});
```

### 3.3 Cognito User Pool

```typescript
const userPool = new sst.aws.CognitoUserPool("UserPool", {
  usernames: ["email"],
});

const userPoolClient = userPool.addClient("WebClient", {
  // Hosted UI callback URLs are set post-deploy or via a second pass
  // after the CloudFront URL is known
  transform: {
    client: {
      allowedOauthFlows: ["code"],
      allowedOauthScopes: ["email", "openid", "profile"],
      allowedOauthFlowsUserPoolClient: true,
      explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      generateSecret: false, // public client (SPA)
      callbackUrls: $dev
        ? ["https://localhost:5173/auth/callback"]
        : [web.url.apply(url => `${url}/auth/callback`)],
      logoutUrls: $dev
        ? ["https://localhost:5173"]
        : [web.url],
    },
  },
});
```

> **Note on callback URL bootstrapping:** The Cognito client needs the CloudFront URL before it can be configured, but the CloudFront URL doesn't exist until after the first deploy. On first deploy, use a placeholder URL and update after the `web` resource outputs its URL. SST's `$dev` flag is used to switch between localhost and production URLs automatically.

### 3.4 API Gateway with JWT Authorizer

```typescript
const api = new sst.aws.ApiGatewayV2("Api", {
  cors: {
    allowOrigins: $dev ? ["https://localhost:5173"] : [web.url],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    allowCredentials: true, // required for httpOnly cookie on /auth/* routes
  },
});

// JWT authorizer — validates Cognito tokens at API Gateway level
const authorizer = api.addAuthorizer({
  name: "CognitoAuthorizer",
  jwt: {
    issuer: $interpolate`https://cognito-idp.${aws.getRegionOutput().name}.amazonaws.com/${userPool.id}`,
    audiences: [userPoolClient.id],
  },
});
```

### 3.5 Lambda Routes

Each route declaration in SST creates a Lambda function, bundles the handler file via esbuild, and wires the route to the API Gateway:

```typescript
// Game routes — JWT authorizer required
const getSnippetFn = api.route("GET /api/snippet", {
  handler: "backend/functions/get-snippet.handler",
  link: [table, snippetBucket],
  environment: {
    CLOUDFRONT_DOMAIN: distribution.domainName,
  },
  authorizer: authorizer.id,
  memory: "512 MB",
  timeout: "10 seconds",
});

const submitAnswerFn = api.route("POST /api/answer", {
  handler: "backend/functions/submit-answer.handler",
  link: [table],
  authorizer: authorizer.id,
  memory: "1024 MB",
  timeout: "15 seconds",
});

const getProgressFn = api.route("GET /api/progress", {
  handler: "backend/functions/get-progress.handler",
  link: [table],
  authorizer: authorizer.id,
  memory: "512 MB",
  timeout: "10 seconds",
});

// Auth routes — no JWT authorizer
const authSessionFn = api.route("POST /auth/session", {
  handler: "backend/functions/auth-session.handler",
  link: [table],
  environment: {
    COGNITO_CLIENT_ID: userPoolClient.id,
  },
  memory: "256 MB",
  timeout: "10 seconds",
});

const authRefreshFn = api.route("POST /auth/refresh", {
  handler: "backend/functions/auth-refresh.handler",
  environment: {
    COGNITO_CLIENT_ID: userPoolClient.id,
    COGNITO_DOMAIN: $interpolate`https://${userPool.id}.auth.${aws.getRegionOutput().name}.amazoncognito.com`,
  },
  memory: "256 MB",
  timeout: "10 seconds",
});

const authLogoutFn = api.route("POST /auth/logout", {
  handler: "backend/functions/auth-logout.handler",
  environment: {
    COGNITO_CLIENT_ID: userPoolClient.id,
    COGNITO_DOMAIN: $interpolate`https://${userPool.id}.auth.${aws.getRegionOutput().name}.amazoncognito.com`,
  },
  memory: "256 MB",
  timeout: "10 seconds",
});
```

### 3.6 CloudFront Distribution for Snippet Bucket

The snippet bucket is fronted by a separate CloudFront distribution (distinct from the SPA's CloudFront) to serve snippet content with OAC:

```typescript
const distribution = new aws.cloudfront.Distribution("SnippetDistribution", {
  origins: [{
    domainName: snippetBucket.bucketRegionalDomainName,
    originId: "SnippetBucketOrigin",
    s3OriginConfig: {
      originAccessIdentity: "", // OAC replaces OAI; wired separately
    },
  }],
  defaultCacheBehavior: {
    allowedMethods: ["GET", "HEAD"],
    cachedMethods: ["GET", "HEAD"],
    targetOriginId: "SnippetBucketOrigin",
    viewerProtocolPolicy: "redirect-to-https",
    cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // CachingOptimized managed policy
  },
  enabled: true,
  httpVersion: "http2",
});
```

### 3.7 React SPA Static Site

```typescript
const web = new sst.aws.StaticSite("Web", {
  path: "frontend",
  build: {
    command: "npm run build",
    output: "dist",
  },
  environment: {
    VITE_API_URL: api.url,
    VITE_COGNITO_USER_POOL_ID: userPool.id,
    VITE_COGNITO_CLIENT_ID: userPoolClient.id,
    VITE_COGNITO_DOMAIN: $interpolate`https://${userPool.id}.auth.${aws.getRegionOutput().name}.amazoncognito.com`,
  },
  // CloudFront custom error: all 403/404s → index.html (React Router history mode)
  errorPage: "index.html",
});
```

---

## 4. Lambda Function Configuration

### 4.1 Shared esbuild behaviour

SST bundles each Lambda handler independently. Relative imports from `backend/lib/` are resolved at bundle time and tree-shaken per function. No shared Lambda layer is needed.

TypeScript compilation is handled entirely by SST/esbuild — the root `tsconfig.json` remains minimal (`{}`). Each Lambda outputs a single `.mjs` bundle with source maps in non-production stages.

### 4.2 Runtime and architecture

All Lambda functions use:
- **Runtime:** Node.js 22.x (current LTS, `arm64` architecture for ~20% cost reduction)
- **Architecture:** `arm64` (Graviton2)

### 4.3 Resource linking via SST `link`

SST's `link` property automatically grants IAM permissions and injects resource ARNs/names as environment variables. For example, `link: [table]` grants the Lambda `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Query`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem` on the table and injects `Resource.AppTable.name` into the Lambda environment.

Custom environment variables (e.g. `CLOUDFRONT_DOMAIN`, `COGNITO_CLIENT_ID`) are declared explicitly alongside `link` for values that SST doesn't automatically wire.

### 4.4 IAM least-privilege notes

SST's default link grants are broad (all DynamoDB actions on the table). Until SST supports fine-grained action control, Lambda functions should validate their own access at the application level (e.g., `SubmitAnswer` can only write to `USER#<own-sub>`). Post-launch, custom IAM policies can be applied via the `transform` escape hatch.

---

## 5. Environment Variables & Linking

| Variable | Set by | Consumed by |
|---|---|---|
| `Resource.AppTable.name` | SST link | All game Lambdas |
| `Resource.SnippetBucket.name` | SST link | `GetSnippet` |
| `CLOUDFRONT_DOMAIN` | Explicit env | `GetSnippet` |
| `COGNITO_CLIENT_ID` | Explicit env | `AuthSession`, `AuthRefresh` |
| `COGNITO_DOMAIN` | Explicit env | `AuthRefresh` |
| `VITE_API_URL` | SST StaticSite env | Frontend build |
| `VITE_COGNITO_USER_POOL_ID` | SST StaticSite env | Frontend build |
| `VITE_COGNITO_CLIENT_ID` | SST StaticSite env | Frontend build |
| `VITE_COGNITO_DOMAIN` | SST StaticSite env | Frontend build |

---

## 6. Custom Domain

**Production domain:** `secure-train.edoatley.co.uk` (DNS managed in Route 53 or via CNAME to the CloudFront distribution).

| Endpoint | URL |
|---|---|
| SPA (frontend) | `https://secure-train.edoatley.co.uk` |
| API Gateway | `https://api.secure-train.edoatley.co.uk` |
| Snippet CDN | `https://content.secure-train.edoatley.co.uk` |

Using subdomains of the same apex domain (`edoatley.co.uk`) is critical for `SameSite=Strict` cookie behaviour — the browser considers `secure-train.edoatley.co.uk` and `api.secure-train.edoatley.co.uk` as same-site (same eTLD+1), so the refresh cookie set by the API will be forwarded by the browser on SPA→API requests.

**SST custom domain configuration:**

```typescript
const web = new sst.aws.StaticSite("Web", {
  // ...
  domain: $app.stage === "production"
    ? { name: "secure-train.edoatley.co.uk", dns: sst.aws.dns() }
    : undefined,
});

const api = new sst.aws.ApiGatewayV2("Api", {
  // ...
  domain: $app.stage === "production"
    ? { name: "api.secure-train.edoatley.co.uk", dns: sst.aws.dns() }
    : undefined,
});
```

Non-production stages use auto-generated CloudFront/API Gateway URLs. ACM certificates are provisioned automatically by SST in `us-east-1` (required for CloudFront).

---

## 7. Stage Strategy

| Stage | Behaviour |
|---|---|
| `dev` (local) | `sst dev` runs Lambdas live (real AWS resources in a personal dev stage); frontend runs on `https://localhost:5173` via Vite + mkcert |
| `<personal>` (e.g. `edo`) | Named personal deployed stage; full cloud deployment, `removal: "remove"` |
| `production` | `removal: "retain"`; custom domain `secure-train.edoatley.co.uk`; CORS restricted to that domain; Cognito callback URLs use production domain |

`$dev` is an SST built-in boolean that is `true` only during `sst dev`. It is used to switch CORS origins and Cognito callback URLs without an explicit stage name check.

---

## 8. Decisions & Alternatives

### 7.1 SST v4 vs. CDK / Terraform

| Option | Pros | Cons |
|---|---|---|
| **SST v4 (chosen)** | Unified TS config; esbuild bundling built-in; `sst dev` live Lambda; resource linking auto-wires IAM + env vars | Newer, smaller community than CDK; Pulumi engine under the hood adds an abstraction layer |
| AWS CDK | Mature; large ecosystem; fine-grained control | More boilerplate; separate bundling step (aws-cdk-lib constructs); no built-in live dev |
| Terraform | Language-agnostic; industry standard for multi-cloud | No native Lambda bundling; separate tool from application code |

### 7.2 Separate CloudFront for snippet bucket vs. same distribution

Using a separate CloudFront distribution for the snippet bucket (rather than adding an S3 origin to the SPA's distribution) keeps the SPA CDN config independent of the content CDN config. Cache policies, security headers, and OAC configuration differ between the two origins. SST's `StaticSite` manages the SPA's CloudFront internally and doesn't expose multi-origin configuration.

### 7.3 One file per Lambda vs. monolithic handler

One file per Lambda keeps bundle sizes small, makes IAM least-privilege reasoning easier, and avoids a router inside the Lambda. The shared `backend/lib/` pattern gives code reuse without a monolithic handler.

### 7.4 No Lambda layers

esbuild tree-shaking makes layers unnecessary at this scale. Each bundle is self-contained, which simplifies deployment and avoids layer version management.

---

## 9. Edge Case Probe

1. **Cognito callback URL bootstrapping:** On first deploy, the Cognito client `callbackUrls` cannot reference `web.url` because CloudFront hasn't been created yet. How is the first deploy handled? A two-pass deploy (first pass with placeholder URL, second pass after `web.url` is known) or a hardcoded placeholder that is updated post-deploy?

2. **`sst dev` and httpOnly cookies — resolved:** Vite is configured to serve the frontend over HTTPS in dev using a locally-trusted certificate generated by `mkcert`. Cookie policy (`HttpOnly; Secure; SameSite=Strict`) is identical in dev and production. One-time developer setup: `brew install mkcert && mkcert -install && mkcert localhost`. The generated `localhost.pem` / `localhost-key.pem` are referenced in `vite.config.ts` under `server.https` and are git-ignored. The Cognito callback URL for dev becomes `https://localhost:5173/auth/callback` and the CORS origin becomes `https://localhost:5173`.

3. **`forceDestroy` on the snippet bucket:** If `sst remove` is run on a stage that has snippets loaded, the bucket is destroyed with all its objects. This is intentional for dev stages but destructive if accidentally run on production. Is there a guard needed?

4. **SST link IAM scope:** `link: [table]` grants broad DynamoDB permissions on the whole table. A `GetSnippet` Lambda technically has write access it shouldn't need. Is a custom IAM policy via `transform` required at launch, or is application-level enforcement sufficient initially?

5. **CloudFront domain chicken-and-egg for `GetSnippet`:** `GetSnippet` needs `CLOUDFRONT_DOMAIN` to construct snippet content URLs, but the CloudFront distribution's domain isn't known until after first deploy. This is the same bootstrapping problem as the Cognito callback URL — how is it handled on first deploy?

6. **`sst dev` and the snippet CloudFront distribution:** During `sst dev`, the snippet CloudFront distribution is still deployed to AWS (it's not emulated locally). Snippet content requests from the local frontend go to the real CloudFront. This means the snippet bucket must be seeded before local development can show real snippets. Is there a local fallback strategy?

7. **Frontend `VITE_*` env vars are baked into the build:** If Cognito client IDs or the API URL change (e.g., after a redeploy that recreates the user pool), the frontend must be rebuilt and redeployed. SST's `StaticSite` handles this automatically on `sst deploy`, but it is a footgun if someone updates infra without redeploying the frontend.
