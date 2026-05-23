import type { SubmitResponse, Tier } from "../types";

interface ResultCardProps {
  result: SubmitResponse;
  onNext: () => void;
}

const TIER_ORDER: Tier[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED"];

const TIER_LABELS: Record<Tier, string> = {
  BEGINNER: "Beginner",
  INTERMEDIATE: "Intermediate",
  ADVANCED: "Advanced",
};

const TIER_COLOURS: Record<Tier, string> = {
  BEGINNER: "#22c55e",
  INTERMEDIATE: "#f59e0b",
  ADVANCED: "#ef4444",
};

export function ResultCard({ result, onNext }: ResultCardProps) {
  const { correct, score, tierChange } = result;

  return (
    <div
      style={{
        background: correct ? "#0d3b1a" : "#3b0d0d",
        border: `1px solid ${correct ? "#22c55e" : "#ef4444"}`,
        borderRadius: "0.5rem",
        padding: "1.5rem",
        marginTop: "1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <span style={{ fontSize: "2rem" }}>{correct ? "✅" : "❌"}</span>
        <h2 style={{ margin: 0, color: correct ? "#22c55e" : "#ef4444", fontSize: "1.25rem" }}>
          {correct ? "Correct!" : "Incorrect"}
        </h2>
      </div>

      {correct && result.snippet && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ marginBottom: "0.5rem" }}>
            <span
              style={{
                background: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "0.25rem",
                padding: "0.2rem 0.5rem",
                fontSize: "0.75rem",
                fontFamily: "monospace",
                color: "#94a3b8",
              }}
            >
              OWASP {result.snippet.owaspCategory.replace(/_/g, " ")}
            </span>
          </div>
          <p style={{ color: "#cbd5e1", lineHeight: 1.6, margin: "0.5rem 0 0" }}>
            {result.snippet.explanation}
          </p>
        </div>
      )}

      {!correct && (
        <p style={{ color: "#94a3b8", marginBottom: "1rem" }}>
          Keep studying — submit again to see the explanation.
        </p>
      )}

      <div
        style={{
          display: "flex",
          gap: "1rem",
          fontSize: "0.8rem",
          color: "#64748b",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <span>Score: {(score.compositeScore * 100).toFixed(0)}%</span>
        <span>Correct rate: {(score.rollingCorrectRate * 100).toFixed(0)}%</span>
        <span>Window: {score.windowSize} attempts</span>
      </div>

      {tierChange.changed && (
        <div
          style={{
            background: "#1e293b",
            borderRadius: "0.375rem",
            padding: "0.75rem",
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "1.25rem" }}>
            {TIER_ORDER.indexOf(tierChange.current) > TIER_ORDER.indexOf(tierChange.previous) ? "🎉" : "📉"}
          </span>
          <span style={{ color: "#e2e8f0" }}>
            {TIER_ORDER.indexOf(tierChange.current) > TIER_ORDER.indexOf(tierChange.previous) ? "Promoted to " : "Moved to "}
            <strong style={{ color: TIER_COLOURS[tierChange.current] }}>
              {TIER_LABELS[tierChange.current]}
            </strong>
          </span>
        </div>
      )}

      <button
        onClick={onNext}
        style={{
          background: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: "0.375rem",
          padding: "0.625rem 1.5rem",
          cursor: "pointer",
          fontSize: "0.9rem",
          fontWeight: 600,
        }}
      >
        {correct ? "Next snippet →" : "Try again"}
      </button>
    </div>
  );
}
