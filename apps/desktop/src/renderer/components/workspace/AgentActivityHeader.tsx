import React from "react";

export function AgentActivityHeader({
  line,
  running,
  waitingApproval,
}: {
  line?: string | null;
  running?: boolean;
  waitingApproval?: boolean;
}) {
  if (!line && !waitingApproval) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        borderBottom: "1px solid var(--orvyn-border-soft)",
        background: "rgba(108,92,255,0.06)",
        flexShrink: 0,
        minHeight: 28,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: waitingApproval ? "var(--orvyn-yellow)" : running ? "var(--orvyn-cyan)" : "var(--orvyn-text-muted)",
          boxShadow: running && !waitingApproval ? "0 0 0 3px rgba(34,211,238,0.18)" : undefined,
          animation: running && !waitingApproval ? "orvyn-orion-dot 1.2s ease-in-out infinite" : undefined,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.7, color: "var(--orvyn-cyan)" }}>ORION</span>
      <span style={{ fontSize: 11.5, color: "var(--orvyn-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {waitingApproval ? "Waiting for approval" : line}
      </span>
      <style>{`@keyframes orvyn-orion-dot { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </div>
  );
}
