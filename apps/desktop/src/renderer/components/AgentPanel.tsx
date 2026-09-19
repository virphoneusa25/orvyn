import React from "react";
import { AgentEventStream } from "./AgentEventStream";

export function AgentPanel({
  workspaceRoot,
  workspaceKind,
  attachRunId,
}: {
  workspaceRoot: string | null;
  workspaceKind: "folder" | "default";
  /** A run started elsewhere (Home composer) that Build should follow. */
  attachRunId?: string | null;
}) {
  if (!workspaceRoot) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Workspace is still starting…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "var(--text)" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 600 }}>
        Build
        <div style={{ fontWeight: 400, opacity: 0.55, fontSize: 11, marginTop: 2 }}>
          {workspaceKind === "folder"
            ? "Using the opened folder"
            : "Using the built-in workspace — open a folder to work in a real project"}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AgentEventStream projectRoot={workspaceRoot} attachRunId={attachRunId} />
      </div>
    </div>
  );
}
