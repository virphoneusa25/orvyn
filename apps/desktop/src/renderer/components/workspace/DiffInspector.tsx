import React, { useEffect, useMemo, useState } from "react";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceDiff } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function DiffInspector({
  diffs,
  focus,
  selectedPath,
  onSelect,
}: {
  diffs: WorkspaceDiff[];
  focus?: { path?: string; fileName?: string } | null;
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);

  const ordered = useMemo(() => {
    if (!focus) return diffs;
    const hit = diffs.filter((d) => matchesFile(d.path, focus));
    const rest = diffs.filter((d) => !hit.includes(d));
    return [...hit, ...rest];
  }, [diffs, focus]);

  useEffect(() => {
    if (selectedPath) {
      const i = ordered.findIndex((d) => d.path === selectedPath);
      if (i >= 0) setIndex(i);
    }
  }, [selectedPath, ordered]);

  if (ordered.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No changes yet</div>
        <div style={emptyBody()}>Edits will appear here as ORION works.</div>
      </div>
    );
  }

  const current = ordered[Math.min(index, ordered.length - 1)]!;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <button style={{ ...ghostBtn(), position: "relative" }} onClick={() => setListOpen((v) => !v)}>
          {ordered.length} files changed ▾
        </button>
        <code style={{ flex: 1, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis" }}>{current.path}</code>
        <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>{current.kind === "create" ? "Created" : current.kind === "delete" ? "Deleted" : "Modified"}</span>
        <span style={{ color: "var(--orvyn-green)", fontSize: 11 }}>+{current.additions}</span>
        <span style={{ color: "var(--orvyn-red)", fontSize: 11 }}>−{current.deletions}</span>
      </div>
      {listOpen && (
        <div style={{ borderBottom: "1px solid var(--orvyn-border-soft)", maxHeight: 160, overflowY: "auto", padding: 6 }}>
          {ordered.map((d, i) => (
            <button
              key={d.path}
              onClick={() => {
                setIndex(i);
                setListOpen(false);
                onSelect?.(d.path);
              }}
              style={{
                width: "100%",
                display: "flex",
                gap: 8,
                background: i === index ? "rgba(108,92,255,0.12)" : "transparent",
                border: "none",
                color: "var(--orvyn-text)",
                padding: "5px 6px",
                cursor: "pointer",
                fontSize: 11.5,
              }}
            >
              <code style={{ flex: 1, textAlign: "left" }}>{d.path}</code>
              <span style={{ color: "var(--orvyn-green)" }}>+{d.additions}</span>
              <span style={{ color: "var(--orvyn-red)" }}>−{d.deletions}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, padding: "4px 10px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <button style={ghostBtn()} disabled={index <= 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>Previous change</button>
        <button style={ghostBtn()} disabled={index >= ordered.length - 1} onClick={() => setIndex((i) => Math.min(ordered.length - 1, i + 1))}>Next change</button>
      </div>
      <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 10, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, background: "var(--orvyn-bg)" }}>
        {(current.diff ?? []).map((l, i) => (
          <div
            key={i}
            style={{
              color: l.type === "add" ? "var(--orvyn-green)" : l.type === "remove" ? "var(--orvyn-red)" : "var(--orvyn-text-muted)",
              background: l.type === "add" ? "rgba(32,216,155,0.08)" : l.type === "remove" ? "rgba(242,95,117,0.08)" : undefined,
              whiteSpace: "pre-wrap",
            }}
          >
            {l.type === "add" ? "+ " : l.type === "remove" ? "− " : "  "}
            {l.content}
          </div>
        ))}
        {(!current.diff || current.diff.length === 0) && <div style={{ color: "var(--orvyn-text-muted)" }}>No line-level diff attached.</div>}
      </pre>
    </div>
  );
}
