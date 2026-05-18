import { Link } from "react-router-dom";
import type { Tier, TierCompleteResponse } from "../types";

// @spec GAME-054, GAME-055

const TIER_COLOURS: Record<Tier, string> = {
  BEGINNER: "#22c55e",
  INTERMEDIATE: "#f59e0b",
  ADVANCED: "#ef4444",
};

interface TierCompleteCardProps {
  data: TierCompleteResponse;
}

export function TierCompleteCard({ data }: TierCompleteCardProps) {
  return (
    <div
      style={{
        background: "#1e293b",
        border: "1px solid #334155",
        borderRadius: "0.5rem",
        padding: "2rem",
        textAlign: "center",
        maxWidth: "480px",
        margin: "4rem auto",
      }}
    >
      <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🎓</div>
      <h2 style={{ color: "#f1f5f9", margin: "0 0 0.5rem" }}>Tier Complete!</h2>
      <p style={{ color: "#94a3b8", marginBottom: "1.5rem" }}>
        You've completed all snippets at the{" "}
        <strong style={{ color: TIER_COLOURS[data.tier] }}>{data.tier}</strong> level.
      </p>
      <Link
        to="/progress"
        style={{
          background: "#3b82f6",
          color: "white",
          borderRadius: "0.375rem",
          padding: "0.625rem 1.5rem",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        View progress
      </Link>
    </div>
  );
}
