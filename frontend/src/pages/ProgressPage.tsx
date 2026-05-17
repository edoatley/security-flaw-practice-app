import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ProgressResponse, Tier } from "../types";

const TIER_COLOURS: Record<Tier, string> = {
  BEGINNER: "#22c55e",
  INTERMEDIATE: "#f59e0b",
  ADVANCED: "#ef4444",
};

function ScoreBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.8rem",
          color: "#94a3b8",
          marginBottom: "0.25rem",
        }}
      >
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div
        style={{
          height: "8px",
          background: "#1e293b",
          borderRadius: "4px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444",
            borderRadius: "4px",
            transition: "width 0.4s ease",
          }}
        />
      </div>
    </div>
  );
}

export function ProgressPage() {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getProgress()
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1.5rem",
          borderBottom: "1px solid #1e293b",
          paddingBottom: "1rem",
        }}
      >
        <Link
          to="/game"
          style={{ color: "#64748b", fontSize: "0.875rem", textDecoration: "none" }}
        >
          ← Back to game
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.25rem", color: "#f1f5f9" }}>Progress</h1>
      </div>

      {loading && (
        <div style={{ color: "#64748b", textAlign: "center", padding: "4rem 0" }}>
          Loading…
        </div>
      )}

      {error && (
        <div
          style={{
            background: "#3b0d0d",
            border: "1px solid #ef4444",
            borderRadius: "0.5rem",
            padding: "1.5rem",
            color: "#ef4444",
          }}
        >
          {error}
        </div>
      )}

      {data && (
        <div style={{ maxWidth: "640px" }}>
          {/* Tier card */}
          <div
            style={{
              background: "#0f172a",
              border: `1px solid ${TIER_COLOURS[data.currentTier]}`,
              borderRadius: "0.5rem",
              padding: "1.25rem",
              marginBottom: "1.5rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
              <span
                style={{
                  background: TIER_COLOURS[data.currentTier] + "22",
                  border: `1px solid ${TIER_COLOURS[data.currentTier]}`,
                  color: TIER_COLOURS[data.currentTier],
                  borderRadius: "0.375rem",
                  padding: "0.25rem 0.75rem",
                  fontSize: "0.85rem",
                  fontWeight: 700,
                }}
              >
                {data.currentTier}
              </span>
              <span style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
                {data.totalAttempts} total attempts · {data.correctAttempts} correct
              </span>
            </div>

            <ScoreBar value={data.rolling.compositeScore} label="Rolling composite score (last 20)" />
            <ScoreBar value={data.rolling.correctRate} label="Correct rate" />
            <ScoreBar value={data.rolling.speedScore} label="Speed score" />

            <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.8rem", color: "#64748b", marginTop: "0.75rem" }}>
              {data.rolling.attemptsUntilUpgrade !== null && (
                <span>⬆ {data.rolling.attemptsUntilUpgrade === 0 ? "Promotion pending!" : `~${data.rolling.attemptsUntilUpgrade} to promote`}</span>
              )}
              {data.rolling.attemptsUntilDowngrade !== null && (
                <span>⬇ {data.rolling.attemptsUntilDowngrade === 0 ? "Demotion risk!" : `~${data.rolling.attemptsUntilDowngrade} until demotion risk`}</span>
              )}
            </div>
          </div>

          {/* Recent attempts */}
          {data.recentAttempts.length > 0 && (
            <div>
              <h2 style={{ fontSize: "0.9rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>
                Recent attempts
              </h2>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ color: "#64748b", borderBottom: "1px solid #1e293b" }}>
                    <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 500 }}>Snippet</th>
                    <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 500 }}>Tier</th>
                    <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 500 }}>Result</th>
                    <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 500 }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentAttempts.map((a, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #0f172a" }}>
                      <td style={{ padding: "0.4rem 0.5rem", color: "#94a3b8", fontFamily: "monospace", fontSize: "0.8rem" }}>
                        {a.snippetId.slice(0, 8)}…
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        <span style={{ color: TIER_COLOURS[a.tierId], fontSize: "0.75rem" }}>
                          {a.tierId}
                        </span>
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {a.correct ? (
                          <span style={{ color: "#22c55e" }}>✓ Correct</span>
                        ) : (
                          <span style={{ color: "#ef4444" }}>✗ Wrong</span>
                        )}
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem", color: "#64748b", fontSize: "0.75rem" }}>
                        {new Date(a.timestamp).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
