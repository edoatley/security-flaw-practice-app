# Authentication Component — EARS Specifications

**Component:** Authentication (Frontend SPA + Auth Lambdas)
**Version:** 0.1 (Draft)
**Date:** 2026-05-16
**Status:** Draft
**Sources:**
- `docs/llds/frontend.md` §§ 3, 10.1, 10.7
- `docs/llds/sst-infrastructure.md` §§ 3.3, 3.4
- `docs/llds/api.md` §§ 2.1, auth routes

Spec ID format: `AUTH-{NNN}`
Status markers: `[ ]` = active, `[x]` = implemented, `[D]` = deferred

---

## Table of Contents

1. [PKCE Flow Initiation — Cognito Hosted UI Redirect](#1-pkce-flow-initiation--cognito-hosted-ui-redirect)
2. [Auth Callback — Code Exchange and CSRF Validation](#2-auth-callback--code-exchange-and-csrf-validation)
3. [AuthSession Lambda — Setting the HttpOnly Refresh Cookie](#3-authsession-lambda--setting-the-httponly-refresh-cookie)
4. [AuthRefresh Lambda — Exchanging Cookie for New Access Token](#4-authrefresh-lambda--exchanging-cookie-for-new-access-token)
5. [Silent Refresh — Proactive Refresh at T-5 Minutes](#5-silent-refresh--proactive-refresh-at-t-5-minutes)
6. [Silent Refresh — On Page Load with Cookie Present](#6-silent-refresh--on-page-load-with-cookie-present)
7. [JWT Attachment to API Requests](#7-jwt-attachment-to-api-requests)
8. [401 Handling — Trigger Refresh and Retry](#8-401-handling--trigger-refresh-and-retry)
9. [Logout](#9-logout)
10. [Unauthenticated Access to Protected Routes](#10-unauthenticated-access-to-protected-routes)
11. [Local Development HTTPS Requirement](#11-local-development-https-requirement)
12. [Refresh Cookie Attributes](#12-refresh-cookie-attributes)
13. [Access Token Scope — Memory Only](#13-access-token-scope--memory-only)
14. [Consistency Report](#14-consistency-report)

---

## 1. PKCE Flow Initiation — Cognito Hosted UI Redirect

### AUTH-001 [ ]
**The `<LandingPage>` component shall generate a cryptographically random `code_verifier` of at least 43 characters using `crypto.getRandomValues`.**

*Rationale: PKCE requires a verifier of sufficient entropy. The Web Crypto API is the only cryptographically secure source available in a browser context.*

---

### AUTH-002 [ ]
**The `<LandingPage>` component shall derive the `code_challenge` as `BASE64URL(SHA-256(code_verifier))` using the S256 method.**

*Rationale: S256 is the PKCE challenge method mandated by OAuth 2.0 BCP for public clients. Plain method is prohibited.*

---

### AUTH-003 [ ]
**The `<LandingPage>` component shall generate a cryptographically random `state` parameter for CSRF protection before initiating any Cognito redirect.**

---

### AUTH-004 [ ]
**The `<LandingPage>` component shall store both the `state` value and the `code_verifier` in `sessionStorage` before redirecting to the Cognito Hosted UI.**

*Rationale: `sessionStorage` is tab-scoped and cleared on tab close, limiting the exposure window compared to `localStorage`.*

---

### AUTH-005 [ ]
**When the user has no access token in memory, the `<LandingPage>` component shall redirect the browser to the Cognito Hosted UI URL constructed as:**
```
https://<VITE_COGNITO_DOMAIN>/oauth2/authorize
  ?response_type=code
  &client_id=<VITE_COGNITO_CLIENT_ID>
  &redirect_uri=<VITE_COGNITO_REDIRECT_URI>
  &scope=openid+email
  &state=<random-csrf-token>
  &code_challenge=<PKCE-S256-challenge>
  &code_challenge_method=S256
```

---

### AUTH-006 [ ]
**When the user already has a valid access token in memory, the `<LandingPage>` component shall redirect to `/game` without initiating a Cognito redirect.**

*Rationale: Prevents unnecessary re-authentication for already-authenticated users who navigate to the root route.*

---

## 2. Auth Callback — Code Exchange and CSRF Validation

### AUTH-007 [ ]
**When the browser is redirected to `/auth/callback` by Cognito, the `<AuthCallbackPage>` component shall read the `state` query parameter and compare it against the value stored in `sessionStorage`.**

---

### AUTH-008 [ ]
**If the `state` query parameter does not match the `sessionStorage` value, the `<AuthCallbackPage>` component shall redirect to `/` without exchanging the authorization code.**

*Rationale: A state mismatch indicates a potential CSRF attack or a stale/corrupt session. The authorization code must not be exchanged in this case.*

---

### AUTH-009 [ ]
**When the CSRF state check passes, the `<AuthCallbackPage>` component shall POST to the Cognito token endpoint with the following parameters:**
```
grant_type=authorization_code
code=<AUTH_CODE>
redirect_uri=<VITE_COGNITO_REDIRECT_URI>
client_id=<VITE_COGNITO_CLIENT_ID>
code_verifier=<VERIFIER from sessionStorage>
```

---

### AUTH-010 [ ]
**When the Cognito token endpoint returns a successful response, the `<AuthCallbackPage>` component shall store the `access_token` and `id_token` in module-level memory within `AuthProvider`.**

---

### AUTH-011 [ ]
**When the Cognito token endpoint returns a successful response, the `<AuthCallbackPage>` component shall POST the `refresh_token` to `POST /auth/session` to cause the backend to set the httpOnly refresh cookie.**

---

### AUTH-012 [ ]
**After a successful token exchange and session establishment, the `<AuthCallbackPage>` component shall delete both the `state` and `code_verifier` entries from `sessionStorage`.**

*Rationale: These values are single-use. Retaining them beyond the callback creates an unnecessary attack surface.*

---

### AUTH-013 [ ]
**After a successful token exchange and session establishment, the `<AuthCallbackPage>` component shall navigate to `/game`.**

---

## 3. AuthSession Lambda — Setting the HttpOnly Refresh Cookie

### AUTH-014 [ ]
**The `POST /auth/session` route shall operate without a JWT authorizer, as it is the mechanism by which the initial session is established.**

*Rationale: A JWT authorizer cannot be applied here because the caller does not yet have a valid access token stored on the backend.*

---

### AUTH-015 [ ]
**When `POST /auth/session` receives a `refresh_token` in the request body over HTTPS, the AuthSession Lambda shall respond with a `Set-Cookie` header containing the refresh token.**

---

### AUTH-016 [ ]
**The `Set-Cookie` header set by the AuthSession Lambda shall include the attributes `HttpOnly; Secure; SameSite=None; Path=/auth`.**

*Rationale: `HttpOnly` prevents JavaScript from reading the token (XSS protection); `Secure` enforces HTTPS transport and is required alongside `SameSite=None`; `SameSite=None` allows the cookie to be sent on cross-origin requests from the SPA to the API (necessary in local dev and with separate subdomains); `Path=/auth` restricts the cookie's scope to the auth endpoints only.*

---

### AUTH-017 [ ]
**The AuthSession Lambda shall not return the refresh token in the response body.**

*Rationale: The only permissible channel for the refresh token after this point is the HttpOnly cookie. Returning it in the body would expose it to JavaScript.*

---

## 4. AuthRefresh Lambda — Exchanging Cookie for New Access Token

### AUTH-018 [ ]
**The `POST /auth/refresh` route shall operate without a JWT authorizer.**

*Rationale: The route is the mechanism by which a new access token is obtained. Requiring an existing valid access token would make silent refresh impossible once the token expires.*

---

### AUTH-019 [ ]
**When `POST /auth/refresh` is called, the AuthRefresh Lambda shall read the `refresh_token` from the `HttpOnly` cookie forwarded by API Gateway.**

---

### AUTH-020 [ ]
**When the AuthRefresh Lambda receives a valid refresh token cookie, it shall call the Cognito token endpoint with `grant_type=refresh_token` and return the new `access_token` and `expires_in` values in the JSON response body.**

---

### AUTH-021 [ ]
**When the Cognito token endpoint rejects the refresh token (e.g., token expired or revoked), the AuthRefresh Lambda shall return HTTP 401.**

*Rationale: A 401 from this endpoint signals to the SPA that the session is unrecoverable and the user must re-authenticate.*

---

### AUTH-022 [ ]
**The AuthRefresh Lambda shall not return the refresh token in the response body under any circumstances.**

---

## 5. Silent Refresh — Proactive Refresh at T-5 Minutes

### AUTH-023 [ ]
**When a new access token is stored in memory, `AuthProvider` shall start a timer targeting 5 minutes before the token's expiry (`expires_in - 300` seconds).**

*Rationale: Proactive refresh ensures a valid token is available before the current one expires, preventing mid-session disruption.*

---

### AUTH-024 [ ]
**When the proactive refresh timer fires, `AuthProvider` shall call `POST /auth/refresh`, replace the in-memory access token with the new token returned, and reset the expiry timer.**

---

### AUTH-025 [ ]
**When the proactive refresh timer fires, `AuthProvider` shall call `POST /auth/refresh` using the same `isRefreshing` flag that guards 401-triggered refreshes, to prevent concurrent refresh attempts.**

*Rationale: A proactive timer firing simultaneously with a 401-triggered refresh could result in two concurrent calls to `/auth/refresh`, potentially causing a race condition on refresh token rotation.*

---

### AUTH-026 [ ]
**When the proactive refresh call returns HTTP 401, `AuthProvider` shall clear the in-memory access token, set `isAuthenticated` to `false`, and dispatch a `SESSION_EXPIRED` window event.**

---

## 6. Silent Refresh — On Page Load with Cookie Present

### AUTH-027 [ ]
**When `<ProtectedRoute>` renders and no access token is present in memory, the system shall attempt a single call to `POST /auth/refresh` before redirecting the user to `/`.**

*Rationale: A page reload clears in-memory state. If the user has a valid refresh cookie from a prior session, silent re-authentication avoids an unnecessary round-trip through the Cognito Hosted UI.*

---

### AUTH-028 [ ]
**When the page-load silent refresh call to `POST /auth/refresh` succeeds, `<ProtectedRoute>` shall store the returned access token in memory and render the protected children.**

---

### AUTH-029 [ ]
**When the page-load silent refresh call to `POST /auth/refresh` returns HTTP 401 or fails with a network error, `<ProtectedRoute>` shall redirect the browser to `/`.**

---

## 7. JWT Attachment to API Requests

### AUTH-030 [ ]
**The `apiClient` module shall maintain the access token in a module-level variable (`accessToken`) that is set via the exported `setAccessToken(token: string | null)` function.**

---

### AUTH-031 [ ]
**While an access token is present in the `apiClient` module-level variable, every outgoing API request shall include the header `Authorization: Bearer <accessToken>`.**

---

### AUTH-032 [ ]
**While no access token is present in the `apiClient` module-level variable, the `apiClient` shall send API requests without an `Authorization` header.**

*Rationale: The 401 that results from this will trigger the standard refresh-and-retry path rather than silently failing.*

---

### AUTH-033 [ ]
**`AuthProvider` shall call `setAccessToken(null)` when the user logs out and `setAccessToken(<token>)` whenever a new access token is obtained.**

---

## 8. 401 Handling — Trigger Refresh and Retry

### AUTH-034 [ ]
**When an API request returns HTTP 401 and no refresh is already in progress (`isRefreshing === false`), the `apiClient` shall set `isRefreshing = true`, call `POST /auth/refresh`, and on success store the new access token and retry the original request exactly once.**

---

### AUTH-035 [ ]
**When an API request returns HTTP 401 and a refresh is already in progress (`isRefreshing === true`), the `apiClient` shall wait for the in-progress refresh promise to resolve before retrying the original request with the new token.**

*Rationale: This thundering-herd guard prevents multiple simultaneous 401 responses from generating multiple concurrent refresh calls.*

---

### AUTH-036 [ ]
**When the retry of the original request after a successful token refresh also returns HTTP 401, the `apiClient` shall propagate the error to the caller without initiating another refresh attempt.**

*Rationale: Only one refresh attempt is permitted per original request. A 401 on the retried request indicates a deeper problem that a further refresh will not resolve.*

---

### AUTH-037 [ ]
**When `POST /auth/refresh` returns HTTP 401 during a 401-triggered refresh, the `apiClient` shall clear the in-memory access token, set `isRefreshing = false`, dispatch a `SESSION_EXPIRED` window event, and throw a `SessionExpiredError`.**

---

### AUTH-038 [ ]
**When `AuthProvider` receives a `SESSION_EXPIRED` window event, it shall clear the in-memory access token and set `isAuthenticated` to `false`.**

---

### AUTH-039 [ ]
**When `isAuthenticated` transitions to `false`, `<ProtectedRoute>` shall redirect the browser to `/`.**

---

## 9. Logout

### AUTH-040 [ ]
**When the user clicks the logout button, `authContext.logout()` shall immediately clear the in-memory `accessToken` and `idToken`.**

---

### AUTH-041 [ ]
**When `authContext.logout()` is called, the system shall call `POST /auth/logout` on the backend.**

---

### AUTH-042 [ ]
**When `POST /auth/logout` is called, the backend shall call the Cognito `/oauth2/revoke` endpoint to revoke the refresh token.**

---

### AUTH-043 [ ]
**When `POST /auth/logout` is called, the backend shall respond with a `Set-Cookie` header that expires the refresh cookie by setting `Max-Age=0` with the same `HttpOnly; Secure; SameSite=None; Path=/auth` attributes.**

*Rationale: The cookie must be cleared with identical attributes to those used when it was set; a mismatch in path or security flags will cause the browser to retain the old cookie.*

---

### AUTH-044 [ ]
**After the backend logout call completes, `authContext.logout()` shall redirect the browser to the Cognito logout endpoint:**
```
https://<VITE_COGNITO_DOMAIN>/logout
  ?client_id=<VITE_COGNITO_CLIENT_ID>
  &logout_uri=<LANDING_PAGE_URI>
```

*Rationale: This invalidates the Cognito session cookie, preventing other tabs or future sessions from reusing the Cognito SSO session without re-authenticating.*

---

### AUTH-045 [ ]
**The `apiClient` module shall call `setAccessToken(null)` as part of the logout sequence before any network calls are made.**

*Rationale: Clearing the in-memory token immediately prevents any in-flight retry logic from using a token that has been intentionally invalidated.*

---

## 10. Unauthenticated Access to Protected Routes

### AUTH-046 [ ]
**The `<ProtectedRoute>` component shall wrap all routes at `/game` and `/progress`.**

---

### AUTH-047 [ ]
**When `<ProtectedRoute>` renders and no access token is in memory and the page-load silent refresh attempt has failed, the system shall redirect the browser to `/`.**

---

### AUTH-048 [ ]
**When `<LandingPage>` renders and no access token is in memory, the system shall redirect the browser to the Cognito Hosted UI.**

*Rationale: The landing page at `/` acts as the authentication gateway; an unauthenticated user who reaches it (including via the `<ProtectedRoute>` redirect) is immediately bounced to Cognito.*

---

### AUTH-049 [ ]
**While `<ProtectedRoute>` is awaiting the result of the page-load silent refresh attempt, the system shall not render the protected route's children.**

*Rationale: Rendering children before authentication is confirmed could expose protected UI momentarily before the redirect fires.*

---

## 11. Local Development HTTPS Requirement

### AUTH-050 [ ]
**The Vite development server shall be configured to serve the frontend over HTTPS at `https://localhost:5173` using a locally-trusted TLS certificate generated by `mkcert`.**

*Rationale: The `Secure` attribute on the refresh cookie requires HTTPS. Serving the dev server over HTTP would silently drop the cookie, making the auth flow untestable locally.*

---

### AUTH-051 [ ]
**The `mkcert`-generated certificate files (`localhost.pem`, `localhost-key.pem`) shall be referenced in `vite.config.ts` under `server.https` and shall be excluded from version control via `.gitignore`.**

---

### AUTH-052 [ ]
**Where a developer is setting up a local environment, the system shall require the following one-time setup steps before the auth flow can be tested:**
```bash
brew install mkcert
mkcert -install
mkcert localhost
```

---

### AUTH-053 [ ]
**The Cognito user pool client shall register `https://localhost:5173/auth/callback` as a permitted callback URL when the SST `$dev` flag is `true`.**

*Rationale: Cognito rejects redirects to unregistered callback URLs. The `$dev` flag in `sst.config.ts` switches between the localhost URL and the production CloudFront URL automatically.*

---

### AUTH-054 [ ]
**The API Gateway CORS configuration shall allow `https://localhost:5173` as an origin when the SST `$dev` flag is `true`.**

---

### AUTH-055 [ ]
**The cookie attributes (`HttpOnly; Secure; SameSite=None; Path=/auth`) shall be identical in local development and production environments.**

*Rationale: Testing with relaxed cookie attributes in development means the production security behaviour is never exercised locally, which is precisely the scenario most likely to hide auth bugs.*

---

## 12. Refresh Cookie Attributes

### AUTH-056 [ ]
**The refresh token cookie set by the AuthSession Lambda shall have the `HttpOnly` attribute.**

*Rationale: `HttpOnly` prevents any JavaScript running on the page — including injected XSS payloads — from reading or exfiltrating the refresh token.*

---

### AUTH-057 [ ]
**The refresh token cookie set by the AuthSession Lambda shall have the `Secure` attribute.**

*Rationale: `Secure` ensures the cookie is only transmitted over encrypted HTTPS connections, preventing interception on plain-text HTTP.*

---

### AUTH-058 [ ]
**The refresh token cookie set by the AuthSession Lambda shall have the `SameSite=None` attribute.**

*Rationale: `SameSite=None` is required for the cookie to be sent on cross-origin requests from the SPA (on `localhost:5173` in dev, or a different subdomain) to the API. CSRF risk is mitigated by the combination of `Path=/auth` (limits scope to auth endpoints), the fact that `POST /auth/refresh` returns a new access token in the body (not a state-changing mutation), and the PKCE + `state` parameter protection on the login flow.*

---

### AUTH-059 [ ]
**The refresh token cookie set by the AuthSession Lambda shall have the `Path=/auth` attribute.**

*Rationale: Scoping the cookie to `/auth/refresh` means the browser only attaches it to requests to that specific path, preventing it from being sent with game API requests or any other route.*

---

### AUTH-060 [ ]
**The API Gateway CORS configuration shall include `allowCredentials: true` to permit the browser to send the `HttpOnly` cookie on cross-origin requests to `/auth/refresh`.**

*Rationale: Without `credentials: include` on the fetch and `Access-Control-Allow-Credentials: true` on the server, browsers suppress cookies on cross-origin requests.*

---

### AUTH-061 [ ]
**The frontend fetch call to `POST /auth/refresh` shall include `credentials: 'include'` to ensure the browser attaches the HttpOnly cookie to the request.**

---

## 13. Access Token Scope — Memory Only

### AUTH-062 [ ]
**The system shall never write the access token to `localStorage`, `sessionStorage`, or any other persistent browser storage mechanism.**

*Rationale: Any browser storage accessible to JavaScript can be read by XSS payloads. The access token must remain confined to module-level memory, which is not accessible outside the JavaScript module boundary.*

---

### AUTH-063 [ ]
**The `apiClient` module shall store the access token exclusively in a module-level variable (`let accessToken: string | null = null`) that is not exposed on the `window` object or any other globally accessible reference.**

---

### AUTH-064 [ ]
**`AuthProvider` shall store the access token exclusively by calling `apiClient.setAccessToken()` and shall not place the raw token value into React state or React Context.**

*Rationale: Storing the token in React state or Context would trigger a re-render of every subscribed component on each silent refresh (approximately every 55 minutes). The Context should expose only `isAuthenticated: boolean` and derived identity fields, not the raw token.*

---

### AUTH-065 [ ]
**When the page is reloaded, the access token shall not be recoverable from any browser storage source; the system shall instead rely on the HttpOnly refresh cookie to obtain a new access token via the page-load silent refresh flow (AUTH-027).**

---

### AUTH-066 [ ]
**The `id_token` shall be stored in module-level memory alongside the `access_token` and shall not be written to any persistent browser storage.**

---

---

## 14. Consistency Report

### 14.1 Coverage Assessment

The 66 specifications above map to all 13 required behaviour areas. The cross-reference is as follows:

| Required Behaviour | Specs |
|---|---|
| Cognito Hosted UI redirect (PKCE flow initiation) | AUTH-001 – AUTH-006 |
| Auth callback: code exchange, state/CSRF validation | AUTH-007 – AUTH-013 |
| AuthSession Lambda: setting HttpOnly cookie | AUTH-014 – AUTH-017 |
| AuthRefresh Lambda: exchanging cookie for new access token | AUTH-018 – AUTH-022 |
| Silent refresh: proactive at T-5 minutes | AUTH-023 – AUTH-026 |
| Silent refresh on page load (cookie present, no token in memory) | AUTH-027 – AUTH-029 |
| JWT attachment to API requests | AUTH-030 – AUTH-033 |
| 401 handling: trigger refresh, retry original request | AUTH-034 – AUTH-039 |
| Logout | AUTH-040 – AUTH-045 |
| Unauthenticated access to protected routes: redirect to login | AUTH-046 – AUTH-049 |
| mkcert HTTPS requirement for local dev | AUTH-050 – AUTH-055 |
| Cookie attributes: HttpOnly, Secure, SameSite=None, Path=/auth | AUTH-056 – AUTH-061 |
| Access token scope: memory only, never localStorage | AUTH-062 – AUTH-066 |

---

### 14.2 Gaps Identified in the LLD

**GAP-01 — No `/auth/logout` route in the infrastructure LLD.**
`frontend.md` §3.4 describes a `POST /auth/logout` backend call that revokes the refresh token and clears the cookie, but `sst-infrastructure.md` §3.5 defines only four Lambda routes: `GET /api/snippet`, `POST /api/answer`, `GET /api/progress`, `POST /auth/session`, and `POST /auth/refresh`. There is no `POST /auth/logout` Lambda route declared. The frontend LLD explicitly lists this as the fourth Lambda route, but the SST LLD does not include it.
*Recommended action: Add `POST /auth/logout` Lambda route to `sst-infrastructure.md` §3.5 and create `backend/functions/auth-logout.ts`.*

**GAP-02 — Proactive refresh race with 401-triggered refresh is unresolved.**
`frontend.md` §11 edge case probe #2 identifies that the proactive timer refresh and a 401-triggered refresh could both fire concurrently, because the proactive refresh does not currently check the `isRefreshing` flag. AUTH-025 specifies the required behaviour (share the same flag), but this is a design intent that is not yet present in the LLD prose. The LLD only describes `isRefreshing` in the context of 401 handling.
*Recommended action: Update `frontend.md` §3.3 to explicitly state that the proactive refresh timer also gates on `isRefreshing`.*

**GAP-03 — `POST /auth/session` failure recovery is unspecified.**
`frontend.md` §11 edge case probe #3 notes that if `POST /auth/session` fails after the code exchange succeeds, the user will have an access token in memory but no refresh cookie. The auth flow will work for the current session but will fail on the next page load or silent refresh attempt. No retry strategy or user-visible error is specified anywhere in the LLD or these specs.
*Recommended action: Define the retry policy for `POST /auth/session` failure and add a corresponding EARS specification once the policy is agreed.*

**GAP-04 — `credentials: 'include'` requirement is implicit.**
AUTH-061 specifies that the frontend fetch to `/auth/refresh` must use `credentials: 'include'`. This requirement is implied by the cookie architecture but is not explicitly stated in any of the three source LLDs.
*Recommended action: Add an explicit note in `frontend.md` §3.2 or §6 (API Client) that all requests to `/auth/*` routes must use `credentials: 'include'`.*

**GAP-05 — CORS and `credentials` for `/auth/session`.**
AUTH-060 covers `allowCredentials: true` for cookie-forwarding on `/auth/refresh`. The same CORS setting is needed for `POST /auth/session` (which sets the cookie in the response). The SST LLD §3.4 applies `allowCredentials: true` at the API level, which should cover all routes, but this is worth verifying as some API Gateway configurations apply CORS per-route.

**GAP-06 — `id_token` usage is unspecified beyond storage.**
The LLD confirms that `id_token` is stored in memory (AUTH-066) but does not specify how it is used. `AuthContext` exposes `userId`, `email`, and `currentTier`, which are presumably derived from the `id_token` claims. No spec covers the JWT decoding step or which claims are read. This is a behaviour gap at the boundary of authentication and identity.
*Recommended action: Add specifications for `id_token` claim extraction if this is a testable behaviour.*

---

### 14.3 Contradictions Identified

**CONTRADICTION-01 — Lambda count discrepancy.**
`frontend.md` §3.2 states: *"a dedicated `POST /auth/session` Lambda endpoint (confirmed fourth Lambda alongside GetSnippet, SubmitAnswer, GetProgress)"*. This implies four Lambdas, but `sst-infrastructure.md` §3.5 defines five Lambda routes (`GET /api/snippet`, `POST /api/answer`, `GET /api/progress`, `POST /auth/session`, `POST /auth/refresh`), and the `backend/` directory listing in §2 also includes `auth-logout.ts`. The "fourth Lambda" phrasing in the frontend LLD is stale or was written before `/auth/refresh` and `/auth/logout` were added.

**CONTRADICTION-02 — Logout endpoint receiver.**
`frontend.md` §3.4 step 3b states the backend is called at `POST /auth/logout`, yet `sst-infrastructure.md` §3.5 defines no such route. This is simultaneously a gap (GAP-01) and a contradiction: the frontend LLD asserts the endpoint exists, while the infrastructure LLD does not define it.

---

### 14.4 Implicit Scoping Issues

**SCOPE-01 — `credentials: 'include'` on game API routes.**
AUTH-060 and AUTH-061 ensure credentials are sent to `/auth/*` routes. However, `allowCredentials: true` is set at the API Gateway level (not per-route). This means the `Authorization` header requirement and `credentials: 'include'` mode would also apply to `GET /api/snippet`, `POST /api/answer`, and `GET /api/progress` if the browser sends the cookie along with the access token. This is harmless but should be confirmed as intentional: the game Lambdas use JWT auth (not cookie auth), so the cookie being forwarded is redundant but not a security risk.

**SCOPE-02 — Resolved.** `SameSite=None; Secure` is used so the cookie is sent cross-origin from the SPA to the API. This is required in local dev (SPA on `localhost:5173`, API on `execute-api.amazonaws.com`) and remains correct in production where both share `secure-train.edoatley.co.uk` (same-site in practice). `Secure` is mandatory alongside `SameSite=None`. See `docs/llds/sst-infrastructure.md §6` for the custom domain configuration.

**SCOPE-03 — Resolved.** Cookie `Path=/auth` (widened from `/auth/refresh`) means the cookie is sent to all `/auth/*` routes including `/auth/logout`. The `AuthLogout` Lambda can therefore read the refresh token from the cookie and pass it to Cognito's `/oauth2/revoke` endpoint without requiring the SPA to resend it in the request body.

**SCOPE-04 — `sessionStorage` cross-tab isolation.**
AUTH-004 stores the PKCE `state` and `code_verifier` in `sessionStorage`. `sessionStorage` is isolated per tab (each tab gets its own storage), meaning a PKCE flow started in one tab cannot be completed in another. This is the intended behaviour (it matches OAuth PKCE security expectations), but if the Cognito redirect opens in a new tab, the callback will fail with a state mismatch. The LLD does not confirm whether Cognito's redirect opens in the same tab or a new one. In the standard redirect flow (not a popup), the same tab is used, so this should be safe — but worth confirming as an explicit assumption.
