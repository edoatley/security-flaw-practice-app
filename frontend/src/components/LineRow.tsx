import type { LineVisualState } from "../types";

interface LineRowProps {
  lineNumber: number;
  code: string;
  visualState: LineVisualState;
  onClick?: () => void;
}

const STATE_STYLES: Record<LineVisualState, React.CSSProperties> = {
  default: { background: "transparent" },
  selected: { background: "#1e3a5f", borderLeft: "3px solid #4a9eff" },
  correct: { background: "#0d3b1a", borderLeft: "3px solid #22c55e" },
  incorrect: { background: "#3b0d0d", borderLeft: "3px solid #ef4444" },
  missed: { background: "#3b2200", borderLeft: "3px solid #f97316" },
  unselected: { background: "transparent", opacity: 0.6 },
};

const GUTTER_STYLES: Record<LineVisualState, React.CSSProperties> = {
  default: { cursor: "pointer", color: "#6b7280" },
  selected: { cursor: "pointer", color: "#4a9eff", fontWeight: "bold" },
  correct: { cursor: "default", color: "#22c55e" },
  incorrect: { cursor: "default", color: "#ef4444" },
  missed: { cursor: "default", color: "#f97316" },
  unselected: { cursor: "default", color: "#6b7280" },
};

const RESULT_STATES = new Set<LineVisualState>(["correct", "incorrect", "missed", "unselected"]);

export function LineRow({ lineNumber, code, visualState, onClick }: LineRowProps) {
  const isResultPhase = RESULT_STATES.has(visualState);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        minHeight: "1.5em",
        fontFamily: "monospace",
        fontSize: "0.875rem",
        ...STATE_STYLES[visualState],
        transition: "background 0.15s",
      }}
    >
      <span
        onClick={!isResultPhase ? onClick : undefined}
        style={{
          width: "3rem",
          minWidth: "3rem",
          textAlign: "right",
          paddingRight: "0.75rem",
          paddingLeft: "0.5rem",
          userSelect: "none",
          lineHeight: "1.5em",
          ...GUTTER_STYLES[visualState],
        }}
        title={!isResultPhase ? "Click to toggle line selection" : undefined}
      >
        {lineNumber}
      </span>
      <span
        style={{
          flex: 1,
          whiteSpace: "pre",
          lineHeight: "1.5em",
          paddingRight: "1rem",
          color: "#e2e8f0",
        }}
      >
        {code}
      </span>
      {visualState === "correct" && (
        <span style={{ color: "#22c55e", paddingRight: "0.5rem", userSelect: "none" }}>✓ correct</span>
      )}
      {visualState === "incorrect" && (
        <span style={{ color: "#ef4444", paddingRight: "0.5rem", userSelect: "none" }}>✗ wrong</span>
      )}
      {visualState === "missed" && (
        <span style={{ color: "#f97316", paddingRight: "0.5rem", userSelect: "none" }}>↑ missed</span>
      )}
    </div>
  );
}
