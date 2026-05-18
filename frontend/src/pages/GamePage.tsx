import { useReducer, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { CodeViewer } from "../components/CodeViewer";
import { ErrorDisplay } from "../components/ErrorDisplay";
import { ResultCard } from "../components/ResultCard";
import { TierCompleteCard } from "../components/TierCompleteCard";
import type {
  SnippetResponse,
  SubmitResponse,
  TierCompleteResponse,
  Tier,
  LineVisualState,
} from "../types";

// ── State machine ────────────────────────────────────────────────────────────

type GamePhase = "LOADING" | "PLAYING" | "SUBMITTING" | "RESULT" | "TIER_COMPLETE" | "ERROR" | "ALREADY_SUBMITTED";

interface GameState {
  phase: GamePhase;
  snippet: SnippetResponse | null;
  lines: string[];
  selectedLines: Set<number>;
  result: SubmitResponse | null;
  tierComplete: TierCompleteResponse | null;
  startTime: number;
  error: string | null;
}

type GameAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; snippet: SnippetResponse; lines: string[] }
  | { type: "TIER_COMPLETE"; data: TierCompleteResponse }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "TOGGLE_LINE"; lineNumber: number }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS"; result: SubmitResponse }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "ALREADY_SUBMITTED" }
  | { type: "NEXT" }
  | { type: "RETRY" };

const initialState: GameState = {
  phase: "LOADING",
  snippet: null,
  lines: [],
  selectedLines: new Set(),
  result: null,
  tierComplete: null,
  startTime: 0,
  error: null,
};

function reducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "LOAD_START":
      return { ...initialState, phase: "LOADING" };
    case "LOAD_SUCCESS":
      return {
        ...state,
        phase: "PLAYING",
        snippet: action.snippet,
        lines: action.lines,
        selectedLines: new Set(),
        result: null,
        error: null,
        startTime: Date.now(),
      };
    case "TIER_COMPLETE":
      return { ...state, phase: "TIER_COMPLETE", tierComplete: action.data };
    case "LOAD_ERROR":
      return { ...state, phase: "ERROR", error: action.message };
    case "TOGGLE_LINE": {
      if (state.phase !== "PLAYING" || !state.snippet) return state;
      const cap = state.snippet.vulnerableLineCount;
      const next = new Set(state.selectedLines);
      if (next.has(action.lineNumber)) {
        next.delete(action.lineNumber);
      } else if (next.size < cap) {
        next.add(action.lineNumber);
      }
      return { ...state, selectedLines: next };
    }
    case "SUBMIT_START":
      return { ...state, phase: "SUBMITTING" };
    case "SUBMIT_SUCCESS":
      return { ...state, phase: "RESULT", result: action.result };
    case "SUBMIT_ERROR":
      return { ...state, phase: "ERROR", error: action.message };
    case "ALREADY_SUBMITTED":
      return { ...state, phase: "ALREADY_SUBMITTED" };
    case "NEXT":
      return { ...initialState, phase: "LOADING" };
    case "RETRY":
      if (!state.snippet) return { ...initialState, phase: "LOADING" };
      return {
        ...state,
        phase: "PLAYING",
        selectedLines: new Set(),
        result: null,
        error: null,
        startTime: Date.now(),
      };
    default:
      return state;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

const TIER_COLOURS: Record<Tier, string> = {
  BEGINNER: "#22c55e",
  INTERMEDIATE: "#f59e0b",
  ADVANCED: "#ef4444",
};

export function GamePage() {
  const { logout } = useAuth();
  const [state, dispatch] = useReducer(reducer, initialState);
  const loadingRef = useRef(false);

  async function loadSnippet() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    dispatch({ type: "LOAD_START" });
    try {
      const res = await api.getSnippet();
      if (res.status === "TIER_COMPLETE") {
        dispatch({ type: "TIER_COMPLETE", data: res });
        return;
      }
      const content = await fetch(res.contentUrl).then((r) => r.text());
      const lines = content.split("\n");
      // Strip trailing empty line if file ends with newline
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      dispatch({ type: "LOAD_SUCCESS", snippet: res, lines });
    } catch (err: unknown) {
      dispatch({ type: "LOAD_ERROR", message: String(err) });
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    loadSnippet();
  }, []);

  async function handleSubmit() {
    if (state.phase !== "PLAYING" || !state.snippet || state.selectedLines.size === 0) return;
    dispatch({ type: "SUBMIT_START" });
    try {
      const result = await api.submitAnswer({
        snippetId: state.snippet.snippetId,
        selectedLines: [...state.selectedLines],
        timeTakenMs: Date.now() - state.startTime,
      });
      dispatch({ type: "SUBMIT_SUCCESS", result });
    } catch (err: unknown) {
      const code = (err as { status?: number }).status;
      if (code === 409) {
        dispatch({ type: "ALREADY_SUBMITTED" });
      } else {
        dispatch({ type: "SUBMIT_ERROR", message: String(err) });
      }
    }
  }

  function getLineState(lineNumber: number): LineVisualState {
    const { phase, selectedLines, result } = state;

    if (phase === "PLAYING" || phase === "SUBMITTING") {
      return selectedLines.has(lineNumber) ? "selected" : "default";
    }

    if (phase === "RESULT" && result) {
      const correctLines = new Set(result.snippet?.vulnerableLines ?? []);
      const wasSelected = selectedLines.has(lineNumber);
      const isCorrectLine = correctLines.has(lineNumber);

      if (result.correct) {
        return isCorrectLine ? "correct" : "unselected";
      } else {
        if (wasSelected && isCorrectLine) return "correct";
        if (wasSelected && !isCorrectLine) return "incorrect";
        if (!wasSelected && isCorrectLine) return "missed";
        return "unselected";
      }
    }

    return "default";
  }

  const canSubmit =
    state.phase === "PLAYING" &&
    state.snippet !== null &&
    state.selectedLines.size > 0;

  const atCap =
    state.snippet !== null &&
    state.selectedLines.size >= state.snippet.vulnerableLineCount;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b1120",
        color: "#e2e8f0",
        fontFamily: "system-ui, sans-serif",
        padding: "1.5rem",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1.5rem",
          borderBottom: "1px solid #1e293b",
          paddingBottom: "1rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.25rem", color: "#94a3b8" }}>
          Security Flaw Practice
        </h1>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          {state.snippet && (
            <span
              style={{
                background: "#1e293b",
                border: `1px solid ${TIER_COLOURS[state.snippet.difficulty]}`,
                color: TIER_COLOURS[state.snippet.difficulty],
                borderRadius: "0.375rem",
                padding: "0.2rem 0.6rem",
                fontSize: "0.75rem",
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              {state.snippet.difficulty}
            </span>
          )}
          <Link
            to="/progress"
            style={{ color: "#64748b", fontSize: "0.875rem", textDecoration: "none" }}
          >
            Progress
          </Link>
          <button
            onClick={logout}
            style={{
              background: "transparent",
              border: "1px solid #334155",
              color: "#94a3b8",
              borderRadius: "0.375rem",
              padding: "0.3rem 0.75rem",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Loading */}
      {state.phase === "LOADING" && (
        <div style={{ color: "#64748b", textAlign: "center", padding: "4rem 0" }}>
          Loading snippet…
        </div>
      )}

      {/* Error */}
      {state.phase === "ERROR" && (
        <ErrorDisplay
          message={state.error ?? "Something went wrong."}
          onRetry={() => loadSnippet()}
          onSkip={() => loadSnippet()}
        />
      )}

      {/* Already submitted */}
      {state.phase === "ALREADY_SUBMITTED" && (
        <div
          style={{
            background: "#1c1a08",
            border: "1px solid #f59e0b",
            borderRadius: "0.5rem",
            padding: "1.5rem",
            textAlign: "center",
            maxWidth: "480px",
            margin: "4rem auto",
          }}
        >
          <p style={{ color: "#f59e0b", marginTop: 0, marginBottom: "1rem" }}>
            This snippet was already submitted. Loading the next one…
          </p>
          <button
            onClick={() => loadSnippet()}
            style={{
              background: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              padding: "0.5rem 1.25rem",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Next snippet
          </button>
        </div>
      )}

      {/* Tier Complete */}
      {state.phase === "TIER_COMPLETE" && state.tierComplete && (
        <TierCompleteCard data={state.tierComplete} />
      )}

      {/* Game area */}
      {(state.phase === "PLAYING" ||
        state.phase === "SUBMITTING" ||
        state.phase === "RESULT") &&
        state.snippet && (
          <div style={{ maxWidth: "900px" }}>
            {/* Snippet metadata */}
            <div style={{ marginBottom: "1rem" }}>
              <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem", color: "#f1f5f9" }}>
                {state.snippet.title}
              </h2>
              <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.8rem", color: "#64748b" }}>
                <span>OWASP: {state.snippet.owaspCategory.replace(/_/g, " ")}</span>
                <span>·</span>
                <span>{state.snippet.lineCount} lines</span>
                <span>·</span>
                <span>Select {state.snippet.vulnerableLineCount} vulnerable line{state.snippet.vulnerableLineCount !== 1 ? "s" : ""}</span>
              </div>
            </div>

            {/* Submitting overlay message */}
            {state.phase === "SUBMITTING" && (
              <div style={{ color: "#64748b", marginBottom: "0.5rem", fontSize: "0.875rem" }}>
                Submitting…
              </div>
            )}

            {/* Code viewer */}
            <CodeViewer
              lines={state.lines}
              getLineState={getLineState}
              onLineClick={
                state.phase === "PLAYING"
                  ? (n) => dispatch({ type: "TOGGLE_LINE", lineNumber: n })
                  : undefined
              }
            />

            {/* Selection summary + submit (PLAYING / SUBMITTING) */}
            {(state.phase === "PLAYING" || state.phase === "SUBMITTING") && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  marginTop: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
                  {state.selectedLines.size} / {state.snippet.vulnerableLineCount} line
                  {state.snippet.vulnerableLineCount !== 1 ? "s" : ""} selected
                  {atCap && state.phase === "PLAYING" && (
                    <span style={{ color: "#f59e0b", marginLeft: "0.5rem" }}>
                      — deselect a line to change your answer
                    </span>
                  )}
                </span>
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit || state.phase === "SUBMITTING"}
                  style={{
                    background: canSubmit ? "#3b82f6" : "#1e293b",
                    color: canSubmit ? "white" : "#64748b",
                    border: "none",
                    borderRadius: "0.375rem",
                    padding: "0.625rem 1.5rem",
                    cursor: canSubmit ? "pointer" : "not-allowed",
                    fontWeight: 600,
                    fontSize: "0.9rem",
                    transition: "background 0.15s",
                  }}
                >
                  {state.phase === "SUBMITTING" ? "Submitting…" : "Submit answer"}
                </button>
              </div>
            )}

            {/* Result card */}
            {state.phase === "RESULT" && state.result && (
              <ResultCard
                result={state.result}
                onNext={() => {
                  if (state.result?.correct) {
                    dispatch({ type: "NEXT" });
                    setTimeout(() => loadSnippet(), 0);
                  } else {
                    dispatch({ type: "RETRY" });
                  }
                }}
              />
            )}
          </div>
        )}
    </div>
  );
}
