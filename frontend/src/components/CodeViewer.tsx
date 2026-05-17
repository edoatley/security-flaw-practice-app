import type { LineVisualState } from "../types";
import { LineRow } from "./LineRow";

interface CodeViewerProps {
  lines: string[];
  getLineState: (lineNumber: number) => LineVisualState;
  onLineClick?: (lineNumber: number) => void;
}

export function CodeViewer({ lines, getLineState, onLineClick }: CodeViewerProps) {
  return (
    <div
      style={{
        background: "#0f172a",
        borderRadius: "0.5rem",
        border: "1px solid #1e293b",
        overflow: "auto",
        padding: "0.5rem 0",
      }}
    >
      {lines.map((code, i) => {
        const lineNumber = i + 1;
        return (
          <LineRow
            key={lineNumber}
            lineNumber={lineNumber}
            code={code}
            visualState={getLineState(lineNumber)}
            onClick={onLineClick ? () => onLineClick(lineNumber) : undefined}
          />
        );
      })}
    </div>
  );
}
