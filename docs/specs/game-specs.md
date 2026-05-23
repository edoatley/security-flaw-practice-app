# Game Loop EARS Specifications

**System:** Security Vulnerability Education Platform — Core Game Loop
**Version:** 0.1 (Draft)
**Date:** 2026-05-16
**Status:** Draft
**Source LLDs:** `docs/llds/frontend.md`, `docs/llds/api.md`
**Source HLD:** `docs/high-level-design.md`

---

## Notation

| EARS Pattern | Form |
|---|---|
| Ubiquitous | `The <system> shall <action>` |
| Event-driven | `When <trigger>, the <system> shall <action>` |
| State-driven | `While <state>, the <system> shall <action>` |
| Conditional | `If <condition>, the <system> shall <action>` |

**Status markers:** `[ ]` active &nbsp; `[x]` implemented &nbsp; `[D]` deferred

**Spec ID format:** `GAME-{NNN}` — sequential within each section.

---

## 1. Snippet Loading

### 1.1 Metadata Fetch

**GAME-001** `[x]`
When the game loop enters the LOADING state, the `<GameStateManager>` shall issue an authenticated `GET /api/snippet` request with the current user's Bearer token in the `Authorization` header.

**GAME-002** `[x]`
When `GET /api/snippet` returns HTTP 200 with a well-formed response body, the `<GameStateManager>` shall store the returned `snippetId`, `title`, `language`, `owaspCategory`, `difficulty`, `vulnerableLineCount`, and `lineCount` in the game state.

**GAME-003** `[x]`
When `GET /api/snippet` returns HTTP 200 with a well-formed response body, the `<GameStateManager>` shall extract the `contentUrl` field and immediately issue a second `fetch()` request to that URL without an `Authorization` header.

**GAME-004** `[x]`
When `GET /api/snippet` returns a response body where the `status` field equals `"TIER_COMPLETE"`, the `<GameStateManager>` shall transition to a TIER_COMPLETE display state rather than the PLAYING state.

**GAME-005** `[x]`
When `GET /api/snippet` returns any HTTP 4xx or 5xx status, the `<GameStateManager>` shall transition to the ERROR state and store a user-facing error message without exposing raw server error details.

**GAME-006** `[x]`
When the `GET /api/snippet` network request has not received a response within 15 seconds, the `<GameStateManager>` shall cancel the request using `AbortController` and transition to the ERROR state.

### 1.2 Content Fetch

**GAME-007** `[x]`
When the `contentUrl` fetch returns an HTTP 200 response, the `<GameStateManager>` shall split the response body text on newline characters (`\n`) to produce the `lines` array and store it in the game state.

**GAME-008** `[x]`
When both the `GET /api/snippet` metadata fetch and the `contentUrl` fetch have completed successfully, the `<GameStateManager>` shall transition to the PLAYING state with all snippet data available.

**GAME-009** `[x]`
When the `contentUrl` fetch returns any non-200 HTTP status or fails due to a network error, the `<GameStateManager>` shall transition to the ERROR state and present the same retry options as for a metadata fetch failure.

**GAME-010** `[ ]`
When the `contentUrl` fetch has not received a response within 15 seconds, the `<GameStateManager>` shall cancel the request using `AbortController` and transition to the ERROR state.

---

## 2. Snippet Display

**GAME-011** `[x]`
While in the PLAYING state, the `<CodeViewer>` shall render every element of the `lines` array as a distinct, individually addressable row in the code display.

**GAME-012** `[x]`
While in the PLAYING state, the `<CodeViewer>` shall display a line number to the left of each line of code, with line numbers starting at 1 and incrementing by 1 for each subsequent line.

**GAME-013** `[D]`
While in the PLAYING state, the `<CodeViewer>` shall apply Java syntax highlighting to each line of code using `react-syntax-highlighter` with a custom renderer that preserves per-line click interaction.

**GAME-014** `[x]`
The `<CodeViewer>` shall render line numbers using a non-selectable (`user-select: none`) style so that line numbers are not included when the user copies code text.

---

## 3. TIER_COMPLETE State

**GAME-015** `[x]`
When the `<GameStateManager>` enters the TIER_COMPLETE display state, the `<GamePage>` shall display a message indicating that the user has completed all available snippets at their current difficulty tier.

**GAME-016** `[D]`
When the `<GameStateManager>` enters the TIER_COMPLETE display state, the `<GamePage>` shall display a Reset Progress option that allows the user to request a tier reset.

**GAME-017** `[D]`
When the `<GameStateManager>` enters the TIER_COMPLETE display state and the `canReset` field in the API response is `true`, the Reset Progress option shall be enabled and actionable.

**GAME-018** `[D]`
When the user activates the Reset Progress option, the `<GamePage>` shall call `DELETE /api/progress/tier` and, on success, transition back to the LOADING state. _(Deferred: reset route not implemented in v1.)_

**GAME-019** `[x]`
While in the TIER_COMPLETE display state, the `<GamePage>` shall render the completed tier indicator in a visually distinct greyed-out style to differentiate it from active tiers.

---

## 4. Line Selection

**GAME-020** `[x]`
While in the PLAYING state, the `<LineRow>` shall respond to a click on the line number or the line code area by dispatching a `TOGGLE_LINE` action with the 1-indexed line number of the clicked row.

**GAME-021** `[x]`
When a `TOGGLE_LINE` action is dispatched and the target line number is not in `selectedLines`, the game reducer shall add that line number to `selectedLines`, provided the selection cap has not been reached.

**GAME-022** `[x]`
When a `TOGGLE_LINE` action is dispatched and the target line number is already in `selectedLines`, the game reducer shall remove that line number from `selectedLines`, regardless of the current selection count.

**GAME-023** `[x]`
While in the PLAYING state, a line that is present in `selectedLines` shall be rendered with the `selected` visual state (distinct background colour and bold line number).

**GAME-024** `[x]`
While in the PLAYING state, a line that is not present in `selectedLines` shall be rendered with the `unselected` visual state.

**GAME-025** `[x]`
When a `TOGGLE_LINE` action is dispatched for a phase other than `'playing'`, the game reducer shall treat the action as a no-op and leave `selectedLines` unchanged.

---

## 5. Line Selection Cap

**GAME-026** `[x]`
When a `TOGGLE_LINE` action is dispatched to add a line and `selectedLines.size` is already equal to `snippet.vulnerableLineCount`, the game reducer shall not add the line to `selectedLines`.

**GAME-027** `[x]`
When `selectedLines.size` equals `snippet.vulnerableLineCount`, the `<SelectionSummary>` shall display an inline message informing the user that the maximum number of lines is selected and instructing them to deselect a line to change their answer.

**GAME-028** `[x]`
The `<SelectionSummary>` shall continuously display the current selection count and the maximum in the form "Selected: N / M lines" where N is `selectedLines.size` and M is `snippet.vulnerableLineCount`.

---

## 6. Submit Button State

**GAME-029** `[x]`
While in the PLAYING state and `selectedLines.size` equals zero, the `<SubmitButton>` shall be rendered in a disabled state and shall not respond to click events.

**GAME-030** `[x]`
While in the PLAYING state and `selectedLines.size` is greater than or equal to one, the `<SubmitButton>` shall be rendered in an enabled state and shall respond to click events.

**GAME-031** `[x]`
When the user clicks the `<SubmitButton>` and the game loop transitions to the SUBMITTING state, the `<SubmitButton>` shall immediately be rendered in a disabled state and shall not respond to further click events for the duration of the SUBMITTING and RESULT states.

---

## 7. Submission

**GAME-032** `[x]`
When the user clicks the enabled `<SubmitButton>`, the `<GameStateManager>` shall record the elapsed time in milliseconds since the snippet was first displayed in the PLAYING state as `timeTakenMs`.

**GAME-033** `[x]`
When the user clicks the enabled `<SubmitButton>`, the `<GameStateManager>` shall dispatch a `SUBMIT_START` action, transitioning the game loop to the SUBMITTING state.

**GAME-034** `[x]`
When the `SUBMIT_START` action is dispatched, the `<GameStateManager>` shall issue a `POST /api/answer` request with a JSON body containing `snippetId` (the current snippet's ID), `selectedLines` (the array of 1-indexed selected line numbers), and `timeTakenMs` (the elapsed time in milliseconds, as a non-negative integer).

**GAME-035** `[x]`
The `<GameStateManager>` shall include the current user's Bearer token in the `Authorization` header of every `POST /api/answer` request.

**GAME-036** `[ ]`
The `<GameStateManager>` shall send `timeTakenMs` as an integer value clamped to a maximum of 600,000 milliseconds before including it in the request body.

---

## 8. Double-Submit Defence

**GAME-037** `[x]`
When `POST /api/answer` returns HTTP 409, the `<GameStateManager>` shall transition to the ERROR state and shall display a message that clearly indicates the answer has already been submitted for this snippet.

**GAME-038** `[x]`
When `POST /api/answer` returns HTTP 409, the `<GameStateManager>` shall not re-submit the answer on the next "Retry" action; instead it shall treat the retry as a "Next" action and fetch a new snippet.

---

## 9. Result Display

**GAME-039** `[x]`
When `POST /api/answer` returns HTTP 200, the `<GameStateManager>` shall dispatch a `SUBMIT_SUCCESS` action with the response payload and transition to the RESULT state.

**GAME-040** `[x]`
While in the RESULT state, the `<ResultCard>` shall display whether the user's submission was correct or incorrect, derived from the `correct` field of the submission response.

**GAME-041** `[x]`
While in the RESULT state, the `<ResultCard>` shall display the OWASP category of the snippet's vulnerability, derived from the `owaspCategory` field of the submission response.

**GAME-042** `[x]`
If the submission response contains `correct: true`, the `<ResultCard>` shall display the plain-text or Markdown explanation of the vulnerability, derived from the `explanation` field returned in `snippet` within the submission response.

**GAME-042b** `[x]`
If the submission response contains `correct: false`, the `<ResultCard>` shall not display an explanation; it shall instead display a prompt encouraging the user to try again or skip to the next snippet.

---

## 10. Post-Submission Line Highlighting — Correct and Incorrect Selections

**GAME-043** `[x]`
While in the RESULT state, for every line number that is present in both `selectedLines` and `correctLines` (from `result.correctLines`), the `<LineRow>` shall be rendered with the `correct` visual state (distinct correct-answer background colour).

**GAME-044** `[x]`
While in the RESULT state, for every line number that is present in `selectedLines` but not in `correctLines`, the `<LineRow>` shall be rendered with the `incorrect` visual state (distinct incorrect-selection background colour).

---

## 11. Post-Submission Line Highlighting — Missed Lines

**GAME-045** `[x]`
While in the RESULT state, for every line number that is present in `correctLines` but not present in `selectedLines`, the `<LineRow>` shall be rendered with the `missed` visual state (distinct missed-answer background colour with a dashed outline).

**GAME-046** `[x]`
While in the RESULT state, for every line number that is neither in `selectedLines` nor in `correctLines`, the `<LineRow>` shall be rendered with the `unselected` visual state.

---

## 12. Next Snippet Navigation

**GAME-047** `[x]`
While in the RESULT state, the `<ResultCard>` shall display a Next button that allows the user to proceed to the next snippet.

**GAME-048** `[x]`
When the user clicks the Next button while in the RESULT state, the `<GameStateManager>` shall dispatch a `NEXT` action, clear `selectedLines` and `result` from game state, and transition to the LOADING state.

**GAME-049** `[x]`
When the `NEXT` action causes a transition to the LOADING state, the `<GameStateManager>` shall immediately issue a new `GET /api/snippet` request to fetch the next snippet.

---

## 13. Loading States

**GAME-050** `[ ]`
While in the LOADING state, the `<GameStateManager>` shall render the `<SnippetSkeleton>` component in place of the `<SnippetPanel>` to indicate that content is being fetched.

**GAME-051** `[ ]`
While in the SUBMITTING state, the `<GameStateManager>` shall render the `<SubmittingOverlay>` component on top of the `<SnippetPanel>` to indicate that the answer is being processed.

**GAME-052** `[ ]`
While in the LOADING or SUBMITTING state, the `<SubmitButton>` shall not be visible or shall be in a disabled state so that the user cannot initiate a new submission.

---

## 14. Error States

**GAME-053** `[x]`
When the game loop transitions to the ERROR state from the LOADING state, the `<ErrorDisplay>` shall render a user-facing error message appropriate to the error type (network timeout, server error, or content fetch failure) without exposing raw HTTP status codes, stack traces, or server error bodies.

**GAME-054** `[ ]`
When the game loop transitions to the ERROR state from the SUBMITTING state, the `<ErrorDisplay>` shall render a user-facing error message and shall preserve `selectedLines` and the current snippet data so that the user's selection is not lost.

**GAME-055** `[x]`
While in the ERROR state, the `<ErrorDisplay>` shall display a Retry button that, when clicked, dispatches a `RETRY` action.

**GAME-056** `[x]`
When the user clicks the Retry button in the ERROR state and the previous error occurred during snippet loading, the `<GameStateManager>` shall transition to the LOADING state and re-issue `GET /api/snippet`.

**GAME-057** `[x]`
While in the ERROR state triggered by a LOADING failure, the `<GamePage>` shall also display a Skip button that, when clicked, logs the skip locally and transitions to the LOADING state to fetch a different snippet.

**GAME-058** `[ ]`
If the game loop transitions to the ERROR state, the `<ErrorDisplay>` shall log the raw error details to the browser console only when `import.meta.env.DEV` is `true`; in production builds the raw error shall not be surfaced.

**GAME-059** `[x]`
If `POST /api/answer` returns HTTP 401 and a subsequent token refresh also returns HTTP 401, the `<GameStateManager>` shall not surface an ERROR state; instead the `SessionExpiredError` shall be allowed to propagate to `<ProtectedRoute>`, which redirects the user to the login page.

---

## 15. Time Measurement

**GAME-060** `[x]`
When the game loop transitions from the LOADING state to the PLAYING state, the `<GameStateManager>` shall record the current timestamp (via `Date.now()` or `performance.now()`) as the start of the timing window for the current snippet.

**GAME-061** `[x]`
When the user clicks the enabled `<SubmitButton>`, the `<GameStateManager>` shall compute `timeTakenMs` as the difference in milliseconds between the current timestamp and the timestamp recorded at the start of the PLAYING state.

**GAME-062** `[x]`
The `<GameStateManager>` shall not start the timing window before the transition to the PLAYING state; time spent in the LOADING state (waiting for the API and content fetches) shall not be included in `timeTakenMs`.

**GAME-063** `[ ]`
If the computed `timeTakenMs` exceeds 600,000 milliseconds, the `<GameStateManager>` shall clamp the value to 600,000 before including it in the `POST /api/answer` request body.

---

## Consistency Report

### Coverage Gaps vs. the LLD

**Gap 1 — `vulnerableLineCount = 0` guard (frontend.md §11, edge case 7)**
The LLD notes that `vulnerableLineCount = 0` would permanently disable the Submit button, but neither the LLD nor these specs define a client-side validation guard for this condition. No spec captures the frontend behaviour when `vulnerableLineCount` is zero — the user would see a snippet they can never submit. A defensive spec requiring a data-integrity warning or fallback is missing.

**Gap 2 — `lineCount` vs. `lines.length` validation (frontend.md §11, edge case 8)**
The LLD raises the case where `vulnerableLineCount` exceeds the actual number of lines in the snippet file. No spec here (or in the LLD) defines what the client should do when `lines.length` does not match `lineCount`. Considered out of scope for a client spec, but worth a server-side loader constraint.

**Gap 3 — Empty or whitespace-only content response (frontend.md §11, edge case 9)**
If `contentUrl` returns an empty body, `lines` becomes `['']` and the snippet renders as a single blank line. No spec guards against this. A defensive spec testing `lines.length === 0 || lines.every(l => l.trim() === '')` is absent.

**Gap 4 — Touch / mobile tap targets (frontend.md §11, edge case 12)**
Section 5 of the LLD does not specify minimum tap-target sizes or touch event handling. No EARS spec covers accessibility or minimum interactive area sizes. This is a gap if mobile browsers are in scope.

**Gap 5 — Proactive token refresh race during SUBMITTING (frontend.md §11, edge case 2)**
The LLD notes a potential race between the proactive silent-refresh timer and a 401-triggered refresh during submission. No spec covers the expected behaviour when both fire concurrently. The `isRefreshing` flag prevents duplicate calls on 401-triggered paths but the proactive timer path is not mentioned in the specs.

**Gap 6 — Browser back-button during RESULT state (frontend.md §11, edge case 10)**
Pressing browser back exits the game without any route change (all state is in-memory). No spec captures the expected behaviour — whether game state should be preserved or discarded. This is a known v1 limitation but is undocumented in the specs.

**Gap 7 — `GET /api/progress` call post-submission (high-level-design.md §3, step 6)**
The HLD data-flow description states the SPA calls `GET /api/progress` after each `SubmitAnswer` to refresh the difficulty tier display. No GAME-NNN spec covers this call or the timing of a tier-change notification in the UI. The `tierChange` field returned in the `POST /api/answer` response is also not addressed — there is no spec for displaying a tier promotion or demotion message in the `<ResultCard>`.

**Gap 8 — `SelectionSummary` visibility in RESULT state (frontend.md §5.7)**
The LLD states `<SelectionSummary>` is shown "during PLAYING". It is not specified whether `<SelectionSummary>` is hidden or remains visible during RESULT. No spec captures its state-dependent visibility.

**Gap 9 — 409 Retry semantics ambiguity (api.md §6.2)**
GAME-038 specifies that on HTTP 409, the next "Retry" action should behave as "Next" and fetch a new snippet. However, the LLD's ERROR state transitions table defines "Retry" as `GET /api/snippet` (which is the same as Next). This is consistent, but the spec should make explicit that the user should not be offered a re-submit option on 409, only a "go to next snippet" option — the current wording in GAME-037/038 does not rule out a confusing "Retry" label.

### Contradictions

**Contradiction 1 — `explanation` reveal condition (hld.md §6 vs. api.md §4.3)**
The HLD security requirements state that `explanation` is "never returned to the client — only after a correct submission or on explicit reveal." However, the API LLD's `SubmitAnswer` response contract (§4.3) returns `explanation` on every submission, regardless of whether the answer is correct or incorrect. GAME-042 follows the API LLD (explanation always shown post-submission), but this contradicts the HLD's "only after a correct submission" phrasing. The product intent needs to be clarified: is the explanation always shown post-submission, or only on a correct answer?

**Contradiction 2 — CloudFront URL described as "pre-signed" in HLD, stable in API LLD**
The HLD data-flow description (§3, step 2) mentions "S3 pre-signed URL (or public CloudFront URL)" as if both are options. The API LLD (§3.3 and §D1) definitively chooses a stable CloudFront URL with `expiresAt: null`. GAME-003 follows the LLD. The HLD should be updated to remove the pre-signed URL mention to avoid confusion for implementers.

### Implicit Scoping Issues

**Scoping Issue 1 — TIER_COMPLETE reset route is deferred**
GAME-018 is marked `[D]` because the HLD explicitly defers `DELETE /api/progress/tier`. However, GAME-016 and GAME-017 specify that the Reset Progress button is displayed and enabled based on `canReset: true`. If the button is displayed but the underlying route does not exist, clicking it will produce an unhandled 404. The specs should clarify that the button is shown in the UI but must be connected to a "coming soon" placeholder until the route is implemented, or the display of the button should also be deferred.

**Scoping Issue 2 — `timeTakenMs` clamping is specified at both client and server**
GAME-036 and GAME-063 specify client-side clamping at 600,000 ms. The API LLD §4.2 specifies server-side clamping at the same value. This double-clamping is intentional (defence in depth), but it should be noted that the client clamp is a UX courtesy, not a security control — the server clamp is authoritative. The specs do not make this distinction explicit.

**Scoping Issue 3 — Shift-click is deferred but individual-line click is the only interaction model**
The HLD non-goals explicitly defer shift-click multi-line selection. These specs (particularly the line selection section) assume single-click toggling only. If shift-click is introduced in v2, GAME-020 through GAME-025 would need revision. This is expected but should be noted so that the interaction model is not accidentally implemented as keyboard-only.

**Scoping Issue 4 — `<SnippetMeta>` (OWASP category hint, difficulty) display timing**
The frontend LLD's `<SnippetMeta>` component shows the OWASP category and difficulty during PLAYING. No spec here defines whether the OWASP category is revealed as a hint before submission (which could help the user identify the vulnerability type) or is only confirmed post-submission. This is a product UX decision that is implicit in the component tree but unspecified as a requirement.
