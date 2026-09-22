import React, { useEffect, useState } from "react";
import type { BrowserAction } from "../../agentWorkspaceModel";

export function OrionCursorOverlay({
  cursor,
  status,
}: {
  cursor: { x: number; y: number; kind: BrowserAction["kind"] } | null;
  status?: string | null;
}) {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (cursor?.kind === "click") setPulse((n) => n + 1);
  }, [cursor?.x, cursor?.y, cursor?.kind]);

  if (!cursor) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 4 }}>
      <div
        key={pulse}
        style={{
          position: "absolute",
          left: cursor.x,
          top: cursor.y,
          width: 18,
          height: 18,
          transform: "translate(-3px, -2px)",
          transition: "left 280ms ease, top 280ms ease",
        }}
      >
        {cursor.kind === "click" && (
          <span
            style={{
              position: "absolute",
              inset: -6,
              borderRadius: "50%",
              border: "2px solid rgba(34,211,238,0.7)",
              animation: "orvyn-orion-pulse 420ms ease-out",
            }}
          />
        )}
        {cursor.kind === "type" && (
          <span
            style={{
              position: "absolute",
              left: -10,
              top: 16,
              width: 46,
              height: 3,
              borderRadius: 2,
              background: "rgba(124,92,255,0.55)",
            }}
          />
        )}
        <svg width="18" height="18" viewBox="0 0 18 18">
          <path d="M2 1.6 15.4 8.1l-6.1 1.5L7.4 16.2Z" fill="#22D3EE" stroke="#0b1220" strokeWidth="1" />
        </svg>
        <span
          style={{
            position: "absolute",
            left: 16,
            top: -2,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.4,
            color: "#0b1220",
            background: "var(--orvyn-cyan)",
            borderRadius: 4,
            padding: "1px 4px",
          }}
        >
          ORION
        </span>
      </div>
      {status && (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            fontSize: 11,
            color: "var(--orvyn-text)",
            background: "rgba(11,18,32,0.78)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: 6,
            padding: "4px 8px",
          }}
        >
          {status}
        </div>
      )}
      <style>{`@keyframes orvyn-orion-pulse { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }`}</style>
    </div>
  );
}
