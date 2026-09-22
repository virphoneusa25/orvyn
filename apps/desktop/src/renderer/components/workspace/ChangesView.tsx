import React from "react";
import type { WorkspaceDiff, WorkspaceFile } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle } from "./workspaceChrome";

function statusColor(kind?: string): string {
  if (kind === "created" || kind === "create") return "var(--orvyn-green)";
  if (kind === "deleted" || kind === "delete") return "var(--orvyn-red)";
  return "var(--orvyn-cyan)";
}

export function ChangesView({
  files,
  diffs,
  summary,
  selected,
  onSelect,
}: {
  files: WorkspaceFile[];
  diffs: WorkspaceDiff[];
  summary: { files: number; additions: number; deletions: number };
  selected?: string | null;
  onSelect: (path: string) => void;
}) {
  const rows = diffs.length
    ? diffs
    : files.filter((f) => f.kind !== "read").map((f) => ({
        path: f.path,
        kind: f.kind,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));

  if (rows.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No changes yet</div>
        <div style={emptyBody()}>Edits will appear here as ORION works.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--orvyn-border-soft)", display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 13, fontWeight: 650 }}>{summary.files} {summary.files === 1 ? "file" : "files"} changed</span>
        <span style={{ color: "var(--orvyn-green)", fontSize: 12 }}>+{summary.additions}</span>
        <span style={{ color: "var(--orvyn-red)", fontSize: 12 }}>−{summary.deletions}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
        {rows.map((row) => {
          const active = selected === row.path;
          return (
            <button
              key={row.path}
              onClick={() => onSelect(row.path)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: active ? "rgba(108,92,255,0.12)" : "transparent",
                border: "none",
                borderRadius: 6,
                color: "var(--orvyn-text)",
                padding: "8px 10px",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ color: statusColor(row.kind), fontFamily: "var(--font-mono)", width: 12 }}>{row.kind === "created" || row.kind === "create" ? "+" : row.kind === "deleted" || row.kind === "delete" ? "−" : "●"}</span>
              <code style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{row.path}</code>
              <span style={{ color: "var(--orvyn-green)", fontSize: 11 }}>+{row.additions}</span>
              <span style={{ color: "var(--orvyn-red)", fontSize: 11 }}>−{row.deletions}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
