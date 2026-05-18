// @spec GAME-051, GAME-052, GAME-053

interface ErrorDisplayProps {
  message: string;
  onRetry: () => void;
  onSkip: () => void;
}

export function ErrorDisplay({ message, onRetry, onSkip }: ErrorDisplayProps) {
  const isTimeout = message.includes("AbortError") || message.includes("timeout");
  const friendly = isTimeout
    ? "Request timed out. Check your connection and try again."
    : message.startsWith("Error: ")
    ? message.slice(7)
    : message;

  return (
    <div
      style={{
        background: "#3b0d0d",
        border: "1px solid #ef4444",
        borderRadius: "0.5rem",
        padding: "1.5rem",
        textAlign: "center",
        maxWidth: "480px",
        margin: "4rem auto",
      }}
    >
      <p style={{ color: "#ef4444", marginTop: 0, marginBottom: "1.25rem" }}>{friendly}</p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
        <button
          onClick={onRetry}
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
          Retry
        </button>
        <button
          onClick={onSkip}
          style={{
            background: "transparent",
            color: "#94a3b8",
            border: "1px solid #334155",
            borderRadius: "0.375rem",
            padding: "0.5rem 1.25rem",
            cursor: "pointer",
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
