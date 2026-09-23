import React, { useEffect, useState } from "react";
import type { WorkspaceDiff, WorkspaceFile } from "../../agentWorkspaceModel";
import { DiffInspector } from "./DiffInspector";
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

  const projectRows = rows.filter((row) => row.kind !== "artifact");
  const [active, setActive] = useState(selected ?? projectRows[0]?.path ?? "");

  useEffect(() => {
    if (selected) setActive(selected);
  }, [selected]);

  if (projectRows.length === 0) {
    return (
      <div data-testid="workbench-changes-empty" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No changes</div>
        <div style={emptyBody()}>Project files ORION edits appear here. Generated artifacts stay in Files → Generated.</div>
      </div>
    );
  }

  return (
    <div data-testid="workbench-changes" style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <aside style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--orvyn-border-soft)", display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>{summary.files} {summary.files === 1 ? "file" : "files"} changed</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            <span style={{ color: "var(--orvyn-green)" }}>+{summary.additions}</span>{" "}
            <span style={{ color: "var(--orvyn-red)" }}>−{summary.deletions}</span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px" }}>
          {projectRows.map((row) => {
            const live = active === row.path;
            return (
              <button
                key={row.path}
                onClick={() => {
                  setActive(row.path);
                  onSelect(row.path);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: live ? "rgba(77,163,255,0.12)" : "transparent",
                  border: "none",
                  borderRadius: 6,
                  color: "var(--orvyn-text)",
                  padding: "7px 8px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ color: statusColor(row.kind), fontFamily: "var(--font-mono)", width: 12 }}>
                  {row.kind === "created" || row.kind === "create" ? "+" : row.kind === "deleted" || row.kind === "delete" ? "−" : "M"}
                </span>
                <code style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{row.path}</code>
                <span style={{ color: "var(--orvyn-green)", fontSize: 11 }}>+{row.additions}</span>
                <span style={{ color: "var(--orvyn-red)", fontSize: 11 }}>−{row.deletions}</span>
              </button>
            );
          })}
        </div>
      </aside>
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
        <DiffInspector diffs={diffs} selectedPath={active} onSelect={(path) => { setActive(path); onSelect(path); }} />
      </main>
    </div>
  );
}
