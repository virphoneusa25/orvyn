// apps/desktop/src/renderer/components/HonestState.tsx
//
// The shared truthful "not available yet" surface. Per the no-fake rule,
// workspaces whose backing capability doesn't exist yet explain what's
// missing and what enables it — they never show demo data.
import React from "react";

export function HonestState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 32,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.5, color: "var(--orvyn-text-secondary)" }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", maxWidth: 460, lineHeight: 1.6 }}>
        {message}
      </div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          style={{
            marginTop: 6,
            background: "var(--orvyn-purple)",
            border: "none",
            borderRadius: "var(--orvyn-radius-sm)",
            color: "#fff",
            padding: "7px 16px",
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
