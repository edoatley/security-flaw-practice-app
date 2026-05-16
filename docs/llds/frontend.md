# Low-Level Design: React SPA Frontend

**Component:** Frontend (React SPA)
**Version:** 0.1 (Draft)
**Date:** 2026-05-16
**Status:** Draft
**Parent HLD:** `docs/high-level-design.md`

---

## Table of Contents

1. [Overview](#1-overview)
2. [Component Tree and Screen Flow](#2-component-tree-and-screen-flow)
3. [Auth Flow in Detail](#3-auth-flow-in-detail)
4. [Game Loop State Machine](#4-game-loop-state-machine)
5. [Line Selection Component](#5-line-selection-component)
6. [API Client](#6-api-client)
7. [State Management Approach](#7-state-management-approach)
8. [Error States](#8-error-states)
9. [CSP and Security Header Requirements](#9-csp-and-security-header-requirements)
10. [Decisions and Alternatives](#10-decisions-and-alternatives)
11. [Edge Case Probe](#11-edge-case-probe)

---

## 1. Overview

The frontend is a React single-page application built with Vite. It is deployed as static assets to S3 and served via CloudFront. There is no server-side rendering. All routing is client-side using React Router (hash-based or history-based with CloudFront error page redirect to `index.html`).

The application has four primary screens:

| Screen | Route | Description |
|---|---|---|
| Login / Auth callback | `/` and `/auth/callback` | Redirects to Cognito Hosted UI; handles the OAuth callback |
| Game | `/game` | Displays snippet, line selection, submit |
| Result / Explanation | `/game` (overlay state) | Shown inline after submission; no route change |
| Progress Dashboard | `/progress` | Displays user stats, tier, attempt history |

**Build-time configuration** is injected by SST via Vite's `define` or `import.meta.env`:

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Base URL for all API calls |
| `VITE_COGNITO_DOMAIN` | Cognito Hosted UI domain |
| `VITE_COGNITO_CLIENT_ID` | App client ID |
| `VITE_COGNITO_REDIRECT_URI` | Post-login redirect URI |

These values are baked into the JS bundle at build time. They are not secret.

---

## 2. Component Tree and Screen Flow

### 2.1 Top-Level Component Tree

```
<App>
 ├── <AuthProvider>          (context: auth tokens, user identity)
 │    └── <Router>
 │         ├── <ProtectedRoute>
 │         │    ├── /game     → <GamePage>
 │         │    └── /progress → <ProgressPage>
 │         ├── /auth/callback → <AuthCallbackPage>
 │         └── /             → <LandingPage>  (redirects to Cognito)
 └── <GlobalErrorBoundary>
```

### 2.2 GamePage Component Tree

```
<GamePage>
 ├── <GameHeader>
 │    ├── <TierBadge>          (BEGINNER / INTERMEDIATE / ADVANCED)
 │    └── <LogoutButton>
 ├── <GameStateManager>        (owns the game loop state machine)
 │    ├── [loading]   → <SnippetSkeleton>
 │    ├── [playing]   → <SnippetPanel>
 │    │                  ├── <SnippetMeta>        (OWASP category hint, difficulty)
 │    │                  ├── <CodeViewer>
 │    │                  │    └── <LineRow> × N   (one per line of code)
 │    │                  │         ├── <LineNumber>  (clickable)
 │    │                  │         └── <LineCode>    (syntax-highlighted span)
 │    │                  ├── <SelectionSummary>   ("2 of 3 lines selected")
 │    │                  └── <SubmitButton>
 │    ├── [submitting] → <SnippetPanel> + <SubmittingOverlay>
 │    └── [result]    → <SnippetPanel> (lines annotated) + <ResultCard>
 │                           ├── <CorrectnessIndicator>
 │                           ├── <OwaspCategoryBadge>
 │                           ├── <ExplanationText>
 │                           └── <NextButton>
 └── <ErrorDisplay>           (shown when game loop errors)
```

### 2.3 ProgressPage Component Tree

```
<ProgressPage>
 ├── <PageHeader>
 ├── <TierSummaryCard>
 │    ├── <TierBadge>
 │    ├── <ScoreBar>          (rolling-window correct rate visualised)
 │    └── <AttemptsCount>
 ├── <AttemptHistoryTable>
 │    └── <AttemptRow> × N
 └── <BackToGameLink>
```

### 2.4 Screen Flow

```
Browser opens /
       │
       ▼
<LandingPage>
 hasToken? ──yes──► redirect to /game
       │
       no
       ▼
 redirect to Cognito Hosted UI
       │
       ▼ (user signs in / signs up)
Cognito redirects to /auth/callback?code=...
       │
       ▼
<AuthCallbackPage>
 exchange code → tokens
 store accessToken in memory
 set refreshToken as httpOnly cookie (via /auth/session endpoint or token endpoint)
       │
       ▼
 navigate to /game
       │
       ▼
<GamePage>
 fetch snippet → display → user selects lines → submit
       │
       ▼
<ResultCard> (inline, no route change)
       │
  user clicks "Next"
       │
       ▼
 fetch next snippet (loops)
       │
  user clicks Progress link
       │
       ▼
<ProgressPage>
```

### 2.5 Route Protection

`<ProtectedRoute>` wraps `/game` and `/progress`. It reads the auth context:

- If `accessToken` is present in memory → renders children.
- If not present but a refresh cookie may exist → attempts a silent refresh (one attempt).
- If refresh also fails → redirects to `/` which bounces to Cognito.

---

## 3. Auth Flow in Detail

### 3.1 Cognito Hosted UI Redirect Flow

```
1. User lands on / (no token in memory)
2. <LandingPage> constructs Cognito Hosted UI URL:
      https://<COGNITO_DOMAIN>/oauth2/authorize
        ?response_type=code
        &client_id=<CLIENT_ID>
        &redirect_uri=<REDIRECT_URI>
        &scope=openid+email
        &state=<random-csrf-token>
        &code_challenge=<PKCE-S256-challenge>
        &code_challenge_method=S256
   - state and code_verifier are stored in sessionStorage (short-lived, same tab only)
3. Browser redirects to Cognito Hosted UI
4. User authenticates
5. Cognito redirects to <REDIRECT_URI>/auth/callback?code=<AUTH_CODE>&state=<STATE>
6. <AuthCallbackPage> validates state matches sessionStorage value (CSRF check)
7. <AuthCallbackPage> POSTs to Cognito token endpoint:
      POST https://<COGNITO_DOMAIN>/oauth2/token
        grant_type=authorization_code
        &code=<AUTH_CODE>
        &redirect_uri=<REDIRECT_URI>
        &client_id=<CLIENT_ID>
        &code_verifier=<VERIFIER>
   Response: { access_token, id_token, refresh_token, expires_in }
8. access_token and id_token are stored in module-level memory (React context)
9. refresh_token is stored in an httpOnly, Secure, SameSite=Strict cookie
   - This requires a thin server-side endpoint (see §3.2 below)
10. sessionStorage entries (state, verifier) are cleared
11. Navigate to /game
```

**PKCE:** The app generates a cryptographically random `code_verifier` (min 43 chars) using `crypto.getRandomValues`. The `code_challenge` is `BASE64URL(SHA-256(code_verifier))`.

### 3.2 Refresh Token Cookie Strategy

The Cognito token endpoint returns the `refresh_token` in the JSON body of the token exchange response. The SPA cannot set an httpOnly cookie from JavaScript. Two approaches exist; the chosen approach is:

**Approach (chosen): Thin server-side session endpoint via API Gateway Lambda**

A dedicated `POST /auth/session` Lambda endpoint (confirmed fourth Lambda alongside GetSnippet, SubmitAnswer, GetProgress) receives the `refresh_token` in the request body over HTTPS, then responds with `Set-Cookie: refresh_token=...; HttpOnly; Secure; SameSite=Strict; Path=/auth`. This cookie is only sent by the browser to `/auth/refresh`.

A paired `POST /auth/refresh` Lambda reads the httpOnly cookie (forwarded by API Gateway via configured cookie passthrough), calls the Cognito token endpoint to exchange the refresh token for a new access token, and returns the new access token in the JSON response body. Neither Lambda requires a Cognito JWT authorizer — they are the mechanism by which the access token is obtained, so they operate pre-auth.

The access token is not placed in a cookie. It lives only in the JavaScript module-level variable inside `AuthProvider`.

### 3.3 Silent Refresh

```
AccessToken lifetime: Cognito default = 60 minutes (configurable)
Refresh strategy: proactive refresh at T - 5 minutes

Timeline:
  t=0     token acquired, expiry stored in memory
  t=55min useEffect timer fires → call POST /auth/refresh
            - browser sends httpOnly refresh cookie automatically
            - Lambda exchanges refresh token for new access token
            - new access_token returned in response body
            - old in-memory token replaced
  t=60min (original expiry — already refreshed, no disruption)

If the browser tab has been in the background and the timer fired late:
  - Any 401 response from the API triggers an immediate refresh attempt (§6.2)
```

**Refresh endpoint:** `POST /auth/refresh`
- Browser sends the httpOnly refresh cookie.
- Lambda calls Cognito token endpoint with `grant_type=refresh_token`.
- Returns `{ access_token, expires_in }` in the JSON body.
- If the refresh token itself is expired (default Cognito: 30 days), Lambda returns 401, and the SPA clears in-memory state and redirects to `/`.

### 3.4 Logout

```
1. User clicks Logout
2. <LogoutButton> calls authContext.logout()
3. logout():
   a. Clear in-memory accessToken and idToken
   b. Call POST /auth/logout on backend
      - Backend calls Cognito /oauth2/revoke (refresh token revocation)
      - Backend sets cookie to expire: Set-Cookie: refresh_token=; Max-Age=0; HttpOnly...
   c. Redirect browser to Cognito logout endpoint:
         https://<COGNITO_DOMAIN>/logout
           ?client_id=<CLIENT_ID>
           &logout_uri=<LANDING_PAGE_URI>
   d. Cognito clears its session cookies and redirects to landing page
```

Clearing the in-memory token in step 3a is immediate; the Cognito session revocation (step 3c) ensures other browser tabs that might still have a Cognito session cookie also have that session invalidated.

---

## 4. Game Loop State Machine

### 4.1 States

```
         ┌─────────┐
   start │         │
    ────►│ LOADING │
         │         │◄──────────────────────────────────┐
         └────┬────┘                                   │
              │ snippet fetched                        │ user clicks "Next"
              ▼                                        │
         ┌─────────┐                                   │
         │ PLAYING │                                   │
         │         │                                   │
         └────┬────┘                                   │
              │ user clicks Submit                     │
              ▼                                        │
         ┌────────────┐                                │
         │ SUBMITTING │                                │
         └────┬───────┘                                │
              │ response received                      │
              ▼                                        │
         ┌────────┐                                    │
         │ RESULT │────────────────────────────────────┘
         └────────┘
              │ (also reachable on API error)
              ▼
         ┌────────┐
         │  ERROR │ (transient — user can retry or skip)
         └────────┘
```

### 4.2 State Transitions and Data

| From | Event | To | Side Effect |
|---|---|---|---|
| — | component mounts | LOADING | `GET /api/snippet` called |
| LOADING | fetch success | PLAYING | snippet stored in state |
| LOADING | fetch error | ERROR | error message stored |
| PLAYING | user toggles line | PLAYING | selectedLines updated (no network call) |
| PLAYING | submit button clicked | SUBMITTING | `POST /api/answer` called |
| SUBMITTING | response success | RESULT | result + explanation stored |
| SUBMITTING | response error | ERROR | error message stored |
| RESULT | "Next" clicked | LOADING | selectedLines cleared; `GET /api/snippet` called |
| ERROR | "Retry" clicked | LOADING | previous error cleared; fetch retried |
| ERROR | "Skip" clicked | LOADING | skip logged locally; `GET /api/snippet` called |

### 4.3 State Shape (useReducer)

```typescript
type GamePhase = 'loading' | 'playing' | 'submitting' | 'result' | 'error';

interface SnippetData {
  snippetId: string;
  title: string;
  language: 'java';
  owaspCategory: string;
  difficulty: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
  vulnerableLineCount: number;   // max lines user may select
  lines: string[];               // one entry per line of code
}

interface ResultData {
  correct: boolean;
  correctLines: number[];        // revealed only after submission
  owaspCategory: string;
  explanation: string;
}

interface GameState {
  phase: GamePhase;
  snippet: SnippetData | null;
  selectedLines: Set<number>;    // 1-indexed line numbers
  result: ResultData | null;
  error: string | null;
}
```

Actions:

```typescript
type GameAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; payload: SnippetData }
  | { type: 'FETCH_ERROR'; payload: string }
  | { type: 'TOGGLE_LINE'; payload: number }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_SUCCESS'; payload: ResultData }
  | { type: 'SUBMIT_ERROR'; payload: string }
  | { type: 'NEXT' }
  | { type: 'RETRY' };
```

`useReducer` is used (not `useState`) because multiple state fields change atomically on transitions. The reducer is a pure function, making it straightforward to unit-test each transition.

### 4.4 Snippet Fetch Details

`GET /api/snippet` returns:

```json
{
  "snippetId": "...",
  "title": "...",
  "language": "java",
  "owaspCategory": "A03:2021-Injection",
  "difficulty": "BEGINNER",
  "vulnerableLineCount": 2,
  "contentUrl": "https://..."
}
```

The `contentUrl` points to the snippet text on CloudFront/S3 (no auth required on this URL; content is not sensitive). The SPA issues a second `fetch(contentUrl)` to get the raw text, then splits it on `\n` to produce the `lines` array. Both fetches are awaited before transitioning to PLAYING.

---

## 5. Line Selection Component

### 5.1 Component: `<CodeViewer>`

`<CodeViewer>` renders the code snippet as a table: one `<LineRow>` per line. It receives:

```typescript
interface CodeViewerProps {
  lines: string[];
  language: 'java';
  selectedLines: Set<number>;
  correctLines?: number[];       // present only in RESULT phase
  phase: GamePhase;
  onToggleLine: (lineNumber: number) => void;
  maxSelectableLines: number;    // = snippet.vulnerableLineCount
}
```

### 5.2 Component: `<LineRow>`

```typescript
interface LineRowProps {
  lineNumber: number;            // 1-indexed
  code: string;                  // raw source text for this line
  visualState: LineVisualState;
  isClickable: boolean;
  onClick: () => void;
}

type LineVisualState =
  | 'unselected'
  | 'selected'
  | 'correct'        // post-submission: this line is a correct answer line
  | 'incorrect'      // post-submission: user selected this but it is wrong
  | 'missed';        // post-submission: correct answer line that user did not select
```

### 5.3 Toggling Logic

Toggle logic lives in the reducer (not in `<CodeViewer>`) to keep the component pure:

```
TOGGLE_LINE(n) reducer logic:
  if phase !== 'playing': ignore (no-op)
  if selectedLines.contains(n):
    remove n from selectedLines          // deselect
  else:
    if selectedLines.size >= maxSelectableLines:
      no-op (cap enforced, UX feedback shown)  // do not add
    else:
      add n to selectedLines
```

The client-side cap is a UX aid only. The server validates the same constraint independently and rejects submissions where `selectedLines.length > vulnerableLineCount`.

### 5.4 Visual State Derivation

During PLAYING phase:

| Condition | Visual State |
|---|---|
| line in `selectedLines` | `selected` |
| otherwise | `unselected` |

During RESULT phase:

| Condition | Visual State |
|---|---|
| line in `selectedLines` AND in `correctLines` | `correct` |
| line in `selectedLines` AND NOT in `correctLines` | `incorrect` |
| line NOT in `selectedLines` AND in `correctLines` | `missed` |
| otherwise | `unselected` |

### 5.5 Syntax Highlighting

`react-syntax-highlighter` renders the entire snippet as a styled block. However, to support per-line clickability and per-line visual states, the SPA does not use `react-syntax-highlighter`'s built-in renderer directly. Instead:

- `react-syntax-highlighter` is called with `useInlineStyles={true}` and its `renderer` prop replaced with a custom renderer that maps each token span into a `<LineRow>`.
- The custom renderer receives the tokenised output (array of token arrays per line) and wraps each line in a `<tr>` with the appropriate click handler and CSS class derived from `visualState`.
- This avoids duplicating syntax tokenisation logic while retaining full control over line-level interaction.

### 5.6 CSS Classes for Visual States

```css
.line-row                   { cursor: default; }
.line-row.clickable         { cursor: pointer; }
.line-row.selected          { background: var(--color-selected-bg); }
.line-row.correct           { background: var(--color-correct-bg); }
.line-row.incorrect         { background: var(--color-incorrect-bg); }
.line-row.missed            { background: var(--color-missed-bg); outline: 2px dashed var(--color-missed-outline); }
.line-number                { user-select: none; padding-right: 1em; opacity: 0.5; }
.line-number.clickable      { opacity: 1; }
.line-number.selected       { color: var(--color-selected-fg); font-weight: bold; }
```

### 5.7 SelectionSummary

`<SelectionSummary>` renders below the code block during PLAYING:

```
Selected: 2 / 3 lines  [Submit]
```

When `selectedLines.size >= maxSelectableLines`, a non-blocking inline note appears:

```
Maximum lines selected (3 / 3). Deselect a line to change your answer.
```

The Submit button is enabled only when `selectedLines.size >= 1`. Submitting with zero lines is disallowed client-side (the button is disabled).

---

## 6. API Client

### 6.1 Module Structure

A singleton `apiClient` module is created once at app startup. It is not a class — it is a module with exported async functions.

```typescript
// src/api/client.ts

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> { ... }

export const api = {
  getSnippet: (): Promise<SnippetResponse> =>
    request('GET', '/api/snippet'),

  submitAnswer: (snippetId: string, selectedLines: number[]): Promise<AnswerResponse> =>
    request('POST', '/api/answer', { snippetId, selectedLines }),

  getProgress: (): Promise<ProgressResponse> =>
    request('GET', '/api/progress'),
};
```

`setAccessToken` is called by `AuthProvider` whenever a new token is obtained or on logout (set to `null`).

### 6.2 JWT Attachment

Every `request()` call adds the Bearer token:

```typescript
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};
if (accessToken) {
  headers['Authorization'] = `Bearer ${accessToken}`;
}
```

If `accessToken` is null when `request()` is called, the request is made without an auth header, which will result in a 401 from API Gateway. The 401 handler (§6.3) then attempts a refresh.

### 6.3 401 Handling and Automatic Refresh

```
request() receives HTTP 401
  │
  ├─ isRefreshing? (module-level boolean flag)
  │    yes → wait for pending refresh promise (avoid thundering herd)
  │    no →
  │         set isRefreshing = true
  │         call POST /auth/refresh (sends httpOnly cookie)
  │         ├─ success: store new accessToken; set isRefreshing = false
  │         │           retry original request once with new token
  │         └─ failure (401 from /auth/refresh):
  │                     set isRefreshing = false
  │                     clear accessToken
  │                     dispatch 'SESSION_EXPIRED' event
  │                     throw SessionExpiredError
  │
SessionExpiredError caught by <GameStateManager> / <ProgressPage>
  → redirect to / (which redirects to Cognito)
```

Only one refresh attempt is made per 401. If the retried request also returns 401, the error is propagated to the caller (treated as an API error, not looped).

### 6.4 Request Timeout

Each `request()` call uses `AbortController` with a 15-second timeout. A network timeout throws an `ApiTimeoutError`, which the game loop treats as a transient error (ERROR state, retry available).

### 6.5 Content Fetch (Snippet Text)

The snippet content is fetched with a plain `fetch(contentUrl)` — no auth header — because the CloudFront URL is pre-signed or otherwise access-controlled at the CDN level. This fetch also uses a 15-second timeout via `AbortController`.

---

## 7. State Management Approach

The application deliberately avoids introducing an external state management library (no Redux, no Zustand, no Jotai) for v1. The rationale is that the state is hierarchically scoped with clear ownership:

| State | Owner | Mechanism |
|---|---|---|
| Auth tokens (access, expiry, user identity) | `<AuthProvider>` | React Context + module-level variable for token (not in React state to avoid re-renders on every token refresh) |
| Current user identity (sub, email, tier) | `<AuthProvider>` | React Context |
| Game loop (phase, snippet, selectedLines, result, error) | `<GameStateManager>` | `useReducer` |
| Progress data | `<ProgressPage>` | Local `useState` + `useEffect` on mount |
| UI-only state (hover, focus) | individual components | Local `useState` |

**Why not put game state in context?**
The game state is only needed by `<GamePage>` and its children. Lifting it to a global context would cause unrelated components (e.g., `<ProgressPage>`) to re-render on every line toggle. `useReducer` + prop drilling to direct children is sufficient.

**Why a module-level variable for the access token?**
Storing the JWT in React state would cause a re-render of every component subscribed to `AuthContext` every time the token silently refreshes (every ~55 minutes). The token itself is passed to `apiClient.setAccessToken()` as a side effect; components only need to know "is the user authenticated" (a boolean derived from whether a non-expired token is available), not the raw token value.

```
AuthContext shape:
{
  isAuthenticated: boolean,
  userId: string | null,
  email: string | null,
  currentTier: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | null,
  logout: () => void,
  refreshAuth: () => Promise<void>,
}
```

`AuthProvider` sets up:
- A proactive refresh timer (`setTimeout`) targeting T - 5 min before token expiry.
- A storage event listener on `window` for the `SESSION_EXPIRED` custom event (emitted by the API client on unrecoverable 401).

---

## 8. Error States

### 8.1 Error Classification

| Error Type | Example | UX Behaviour |
|---|---|---|
| Network timeout | No response within 15s | ERROR phase; "Connection problem. Try again." + Retry button |
| API 4xx (non-401) | 400 bad request on submit | ERROR phase; generic message (no raw server error exposed to user) |
| API 401 unrecoverable | Refresh token expired | Redirect to login |
| API 5xx | Lambda crash | ERROR phase; "Something went wrong on our end. Try again." + Retry button |
| Snippet content fetch failure | S3/CloudFront unreachable | ERROR phase; same as 5xx treatment |
| Malformed API response | Missing required field | ERROR phase; logged to console (not surfaced to user); Retry button |
| PKCE state mismatch | Tampered OAuth callback | Redirect to `/`; do not exchange the code |

### 8.2 Error Display

`<ErrorDisplay>` is rendered at the bottom of `<GamePage>` when `phase === 'error'`. It never shows stack traces, raw HTTP error messages, or server error bodies. It shows a user-facing string mapped from the error type.

The raw error is logged to the browser console only in non-production builds (`import.meta.env.DEV`).

### 8.3 Global Uncaught Error Boundary

`<GlobalErrorBoundary>` wraps `<App>`. It catches React render errors (thrown during render, not async fetch errors). On catching, it displays a static fallback page with a "Reload" button and logs the error to the console.

### 8.4 Session Expiry During Game

If the user's session expires mid-game (e.g., tab left open overnight, refresh token expired):

1. The next API call returns 401.
2. `apiClient` attempts a token refresh; refresh endpoint also returns 401.
3. `apiClient` dispatches `SESSION_EXPIRED` window event.
4. `AuthProvider` listens for the event, clears in-memory token, updates `isAuthenticated = false`.
5. `<ProtectedRoute>` detects `isAuthenticated === false`, redirects to `/`.
6. `/` redirects to Cognito Hosted UI.
7. After re-authentication, user is returned to `/game` (the redirect URI).

The in-progress game state (selected lines, current snippet) is lost. This is acceptable for v1; the snippet is simply re-fetched after login.

---

## 9. CSP and Security Header Requirements

These headers are set at the CloudFront level via a CloudFront Response Headers Policy. The frontend must be structured to be compatible with them.

### 9.1 Required Headers

| Header | Value | Frontend Implication |
|---|---|---|
| `Content-Security-Policy` | (see §9.2) | No inline styles without nonce; no `eval()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS only (enforced by CloudFront) |
| `X-Content-Type-Options` | `nosniff` | All assets must be served with correct MIME types |
| `X-Frame-Options` | `DENY` | No iframing of the app |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | No full URL in Referer to third parties |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | App uses none of these |

### 9.2 Content Security Policy

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  connect-src 'self'
              https://<COGNITO_DOMAIN>
              https://<API_GATEWAY_DOMAIN>
              https://<CLOUDFRONT_SNIPPET_DOMAIN>;
  font-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self' https://<COGNITO_DOMAIN>;
  frame-ancestors 'none';
```

**Notes on frontend compatibility:**

- `style-src 'unsafe-inline'` is required because `react-syntax-highlighter` with `useInlineStyles={true}` injects inline `style` attributes. If `'unsafe-inline'` is unacceptable in future, switch to `useInlineStyles={false}` and provide a CSS stylesheet; this requires a style nonce or hash.
- `script-src 'self'` means no CDN-hosted scripts. All JS is bundled by Vite. No `<script src="https://...">` tags.
- The `connect-src` directive must include the Cognito domain (for the token endpoint called from JS), the API Gateway domain, and the CloudFront domain from which snippet content is fetched.
- Vite's dev server injects a HMR WebSocket connection; the CSP above is only enforced in production. The Vite dev server runs without this CSP.
- `eval()` is not used anywhere in the application code or by `react-syntax-highlighter`. Vite's production build does not use `eval()`.

### 9.3 Cache-Control

The CloudFront distribution sets:

| Asset Pattern | Cache-Control |
|---|---|
| `index.html` | `no-cache, no-store` (always fresh; enables cache-busting) |
| `assets/*.js`, `assets/*.css` | `public, max-age=31536000, immutable` (content-hashed filenames by Vite) |
| Snippet content files | `public, max-age=3600` (hour-long cache; content is static) |

---

## 10. Decisions and Alternatives

### 10.1 Token Storage: Memory vs. localStorage

**Decision:** Access token in module-level JS variable; refresh token in httpOnly cookie.

**Alternative considered:** Store both tokens in localStorage.

**Rationale for decision:** localStorage is accessible to any JavaScript on the page, including injected third-party scripts. A stored access token would be exfiltrated by an XSS attack. Memory storage means the token is lost on page refresh (mitigated by silent refresh via the httpOnly cookie). The httpOnly cookie for the refresh token is not readable by JS, so it cannot be exfiltrated by XSS (though it is still vulnerable to CSRF — mitigated by `SameSite=Strict`).

### 10.2 Routing: Hash vs. History Mode

**Decision:** Use React Router in history mode (no `#`). Configure CloudFront to return `index.html` with HTTP 200 for all paths that do not match a known asset.

**Alternative considered:** Hash-based routing (`/#/game`).

**Rationale for decision:** History mode produces cleaner URLs. CloudFront custom error response (404 → 200, body = `index.html`) is straightforward to configure. Hash mode has a minor benefit of being compatible with any static host without server-side config, but CloudFront supports the custom error response natively.

### 10.3 State Management: useReducer vs. External Store

**Decision:** `useReducer` for game loop; React Context for auth.

**Alternative considered:** Zustand or Redux Toolkit for unified state.

**Rationale for decision:** The application has two clearly separated state domains (auth, game loop) with no cross-cutting dependencies between them at v1. The overhead of an external store is not justified. If the progress page needs to reflect a tier change from a just-completed game submission, it can re-fetch from the API on mount rather than sharing state — this also ensures server-truth.

### 10.4 Syntax Highlighting: Custom Renderer vs. Pre-rendered HTML

**Decision:** Use `react-syntax-highlighter` with a custom `renderer` prop to maintain line-level interactivity.

**Alternative considered:** Server-side syntax highlight to HTML, return pre-rendered spans in the API response.

**Rationale for decision:** Keeping highlighting client-side avoids coupling the API to a specific highlighter library or token format. The custom renderer approach is the documented extensibility path for `react-syntax-highlighter`. Server-side pre-rendering would require the backend to match the visual theme and handle escaping consistently, adding complexity for no performance gain (snippets are small).

### 10.5 PKCE vs. Implicit Flow

**Decision:** PKCE (Proof Key for Code Exchange) with `response_type=code`.

**Alternative considered:** Implicit flow (`response_type=token`).

**Rationale for decision:** Implicit flow returns tokens in the URL fragment, which can be leaked in browser history and Referer headers. Cognito supports PKCE for SPAs; it is the current OAuth 2.0 BCP for public clients. Implicit flow is deprecated in OAuth 2.1.

### 10.6 Snippet Content Fetch: API Proxy vs. Direct S3/CloudFront

**Decision:** API returns a `contentUrl` and the SPA fetches the snippet text directly from that URL.

**Alternative considered:** API returns snippet text inline in the JSON response body.

**Rationale for decision:** Returning content via URL allows CloudFront caching of the snippet content independently of the API response. Lambda does not need to read and forward potentially large text payloads. The API response (with `contentUrl`) can itself be cached at the CDN for short TTLs without caching the user-specific adaptive difficulty selection logic.

### 10.7 Local Dev HTTPS: mkcert vs. Relaxed Cookie Policy

**Decision:** Use `mkcert` to serve the Vite dev server over `https://localhost:5173`. Cookie attributes (`HttpOnly; Secure; SameSite=Strict`) are identical in dev and production.

**Alternative considered:** Set `SameSite=Lax` and omit `Secure` in dev only (detected via a `STAGE` env var in the Lambda).

**Rationale for decision:** The httpOnly cookie is a security-critical path. Testing it with different attributes in dev means the production behaviour is untested locally — exactly the scenario most likely to hide auth bugs. `mkcert` is a one-time 5-minute setup per developer machine. The cert files (`localhost.pem`, `localhost-key.pem`) are git-ignored and referenced in `vite.config.ts` under `server.https`.

**Developer setup:**
```bash
brew install mkcert
mkcert -install
mkcert localhost   # generates localhost.pem and localhost-key.pem
```

---

## 11. Edge Case Probe

The following questions identify gaps, unspecified failure modes, or implicit assumptions in the LLD above. They are not bugs — they are open design questions that should be resolved before implementation or in a follow-up design iteration.

### Authentication and Sessions

1. **What happens when the user opens two browser tabs simultaneously?** The access token is stored in a module-level variable, which is per-tab (each tab is an isolated JS context). If tab A silently refreshes, tab B still holds the old access token. Tab B will eventually get a 401, attempt its own refresh, but the refresh token may have already been rotated. Does Cognito support refresh token rotation? If it does, tab B's refresh will fail, forcing the user to log in again on tab B. If it does not rotate, both tabs will independently hold valid access tokens until their separate expiry times. The LLD does not address cross-tab coordination.

2. **What happens to the game state when a silent refresh occurs mid-submission?** The user clicks Submit at t=54m55s, the SUBMITTING fetch starts, and at t=55m the proactive refresh timer fires. Can two concurrent requests be made to `/auth/refresh`? The `isRefreshing` flag handles 401-triggered refreshes, but the proactive timer refresh is separate. A race between the proactive refresh and a 401-triggered refresh could result in two simultaneous calls to `/auth/refresh`. The LLD does not specify whether the proactive timer also sets and checks `isRefreshing`.

3. **What happens if the `/auth/session` endpoint (which sets the httpOnly refresh cookie) fails during the initial token exchange?** The access token was received from Cognito, but the refresh cookie was never set. The user can use the app for the duration of the access token's lifetime (~60 min), but the next refresh will fail immediately (no cookie to send). The LLD does not specify a retry strategy for the session endpoint failure.

4. **What happens if the user's Cognito account is disabled mid-session by an admin?** The access token remains valid until expiry (Cognito does not support token revocation for access tokens by default). Subsequent API calls will succeed for up to 60 minutes. The refresh will fail (Cognito will reject it), triggering the SESSION_EXPIRED flow. There is no faster revocation path without Lambda-based token validation.

5. **What happens to the `sessionStorage` entries (PKCE state, verifier) if the browser crashes between Cognito redirect and the callback?** On next open, the user lands on `/auth/callback?code=...&state=...`, but `sessionStorage` is cleared. The state check fails (CSRF protection), so the code is not exchanged. The LLD says "redirect to /" but the Cognito code is now invalid (single-use). The user must re-initiate login, which is fine — but the error message shown in this case is not specified.

### Game Loop

6. **What happens if `GET /api/snippet` returns a snippet the user has already seen recently?** The backend selects snippets at the user's tier. There is no deduplication guarantee in the LLD. If the snippet pool at a tier is small, the user may see the same snippet twice. The LLD does not specify client-side tracking of seen snippets or a `seenSnippetIds` parameter to pass to the API.

7. **What happens if `vulnerableLineCount` from the API is 0?** The submit button would be permanently disabled (minimum 1 line required). The max-selection cap of 0 means no line can ever be selected. This is a data quality issue in DynamoDB, but the frontend has no guard.

8. **What happens if `vulnerableLineCount` from the API is greater than the total number of lines in the snippet?** The user could theoretically be told to select 10 lines but the snippet only has 8. The client-side cap would never engage. The LLD does not specify a validation step on the received `vulnerableLineCount` vs. `lines.length`.

9. **What happens if the snippet content fetch (`fetch(contentUrl)`) succeeds but returns an empty string?** `lines` would be `['']` (one empty line). The snippet would be rendered as a single blank line with a submit button enabled after selecting it. The LLD does not specify a guard for empty or whitespace-only content.

10. **What happens if the user submits, receives a RESULT, and then presses the browser back button?** The game state lives in React component state, not in the URL. Pressing back navigates to the previous route (likely `/` or wherever the user came from), not to the previous game state. The LLD does not address browser history integration for the game loop.

### Line Selection

11. **What happens if a `correctLines` entry from the submission response refers to a line number outside the range of the snippet's `lines` array?** The visual state derivation would attempt to annotate a non-existent line number. The `<LineRow>` for that number would never be rendered, so nothing visible breaks, but the `missed` state would silently not appear.

12. **What is the touch/mobile behaviour for line selection?** The LLD specifies clickable line numbers but does not address touch events, tap targets (minimum 44×44px for accessibility), or whether the line code region is also tappable (vs. only the line number gutter).

13. **What happens if `react-syntax-highlighter`'s custom renderer API changes in a future version?** The line selection design is coupled to the internal token format of `react-syntax-highlighter`. The LLD does not specify a version pin or an abstraction layer.

### API Client

14. **What happens if multiple simultaneous API calls (e.g., `GET /api/snippet` and `GET /api/progress`) both receive 401 simultaneously?** The `isRefreshing` flag serialises refresh attempts, but the second call must await the refresh promise. The LLD mentions "wait for pending refresh promise" but does not specify the mechanism (e.g., a shared Promise variable that callers can attach `.then()` to vs. a queue).

15. **What happens if `POST /api/answer` times out (15s) after the server has already processed the submission?** The Lambda may have written the attempt to DynamoDB and updated the user's score, but the client gets a timeout error and shows the ERROR state. On retry ("Retry"), it would call `GET /api/snippet` for the next snippet, not re-submit. The LLD does not specify an idempotency key on `POST /api/answer` to prevent double-counting.

### Content Security Policy

16. **The CSP allows `style-src 'unsafe-inline'` due to `react-syntax-highlighter`. Does this decision remain acceptable if additional third-party libraries are added?** `'unsafe-inline'` for styles is less dangerous than for scripts, but it widens the attack surface. The LLD notes switching to `useInlineStyles={false}` as a future option, but does not specify when or what the trigger condition would be.

17. **The `connect-src` directive lists specific domains. What happens during local development?** — Resolved: the CSP is set as a CloudFront response header policy and is only active in deployed stages. During `sst dev`, no CSP is enforced. The Vite dev server itself does not inject CSP headers. The dev frontend runs on `https://localhost:5173` (via mkcert) and connects to the real AWS API Gateway URL, which is injected via `VITE_API_URL` at dev startup by SST.

### Progress Dashboard

18. **How much attempt history does `GET /api/progress` return?** The LLD for the frontend shows `<AttemptRow> × N` but does not specify pagination. If the user has 10,000 attempts, rendering all of them client-side would be slow. The LLD does not address pagination, virtual scrolling, or a cap on history returned.

19. **What happens if the user navigates to `/progress` and `GET /api/progress` is slow?** There is no loading state specified for `<ProgressPage>`. The LLD specifies `useState` + `useEffect` on mount but does not describe a skeleton/spinner for the progress page, unlike the game page which has `<SnippetSkeleton>`.

### General

20. **What is the error recovery strategy for `<GlobalErrorBoundary>` catching a render error?** The LLD says "displays a static fallback page with a Reload button." A hard reload would lose in-memory auth state, forcing the user to log in again. The LLD does not address whether the error boundary could attempt to recover auth state from the httpOnly cookie (via a silent refresh call before reloading).
