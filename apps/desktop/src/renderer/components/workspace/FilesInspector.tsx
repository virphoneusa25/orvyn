import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceFile } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

const GROUPS: { key: WorkspaceFile["kind"][]; label: string }[] = [
  { key: ["modified"], label: "Touched" },
  { key: ["created"], label: "Created" },
  { key: ["deleted"], label: "Deleted" },
  { key: ["read"], label: "Read" },
  { key: ["artifact"], label: "Artifacts" },
];

function kindMark(kind: WorkspaceFile["kind"]): { glyph: string; color: string } {
  if (kind === "created") return { glyph: "＋", color: "var(--orvyn-green)" };
  if (kind === "deleted") return { glyph: "−", color: "var(--orvyn-red)" };
  if (kind === "artifact") return { glyph: "▣", color: "var(--orvyn-cyan)" };
  if (kind === "read") return { glyph: "○", color: "var(--orvyn-text-muted)" };
  return { glyph: "●", color: "var(--orvyn-cyan)" };
}

export function FilesInspector({
  files,
  artifacts,
  projectRoot,
  focus,
  activePath,
  onOpenFile,
  onPreviewArtifact,
}: {
  files: WorkspaceFile[];
  artifacts: WorkspaceFile[];
  projectRoot: string | null;
  focus?: { path?: string; fileName?: string } | null;
  activePath?: string | null;
  onOpenFile: (path: string) => void;
  onPreviewArtifact?: (path: string) => void;
}) {
  const all = useMemo(() => {
    const map = new Map<string, WorkspaceFile>();
    for (const f of files) map.set(f.path, f);
    for (const a of artifacts) map.set(a.path, a);
    return [...map.values()];
  }, [files, artifacts]);

  const [selected, setSelected] = useState<string | null>(activePath ?? all[0]?.path ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [mode, setMode] = useState<"raw" | "render">("raw");

  useEffect(() => {
    if (activePath) setSelected(activePath);
  }, [activePath]);

  useEffect(() => {
    if (!focus) return;
    const hit = all.find((f) => matchesFile(f.path, focus));
    if (hit) setSelected(hit.path);
  }, [focus, all]);

  useEffect(() => {
    if (!selected || !projectRoot) return;
    const ext = selected.split(".").pop()?.toLowerCase() ?? "";
    if (["png", "jpg", "jpeg", "gif", "webp", "pdf"].includes(ext)) {
      setContent(null);
      return;
    }
    let alive = true;
    fetch(apiUrl("/tools/read_file/execute"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ args: { path: selected }, approved: true }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setContent(d.ok ? String(d.output).slice(0, 20000) : `Could not read: ${d.error ?? ""}`);
      })
      .catch(() => alive && setContent(null));
    return () => {
      alive = false;
    };
  }, [selected, projectRoot]);

  if (all.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No files touched yet</div>
        <div style={emptyBody()}>Files ORION reads, creates, or changes will appear here.</div>
      </div>
    );
  }

  const selectedFile = all.find((f) => f.path === selected);
  const ext = selected?.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 42%", minHeight: 120, overflowY: "auto", borderBottom: "1px solid var(--orvyn-border-soft)", padding: "6px 8px" }}>
        {GROUPS.map((g) => {
          const rows = all.filter((f) => g.key.includes(f.kind));
          if (!rows.length) return null;
          return (
            <div key={g.label} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, letterSpacing: 0.8, color: "var(--orvyn-text-muted)", padding: "4px 4px 6px" }}>{g.label.toUpperCase()}</div>
              {rows.map((f) => {
                const mark = kindMark(f.kind);
                const live = f.path === selected;
                return (
                  <button
                    key={f.path}
                    onClick={() => {
                      setSelected(f.path);
                      if (f.kind === "artifact") onPreviewArtifact?.(f.path);
                      else onOpenFile(f.path);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: live ? "rgba(108,92,255,0.12)" : "transparent",
                      border: "none",
                      borderRadius: 5,
                      padding: "5px 6px",
                      cursor: "pointer",
                      color: "var(--orvyn-text)",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ color: mark.color, width: 12 }}>{mark.glyph}</span>
                    <code style={{ flex: 1, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{f.path}</code>
                    {typeof f.additions === "number" && (
                      <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>
                        {f.status ?? "Modified"} · +{f.additions} −{f.deletions ?? 0}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {selected && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
            <code style={{ flex: 1, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{selected}</code>
            {(isMd || isHtml) && (
              <button style={ghostBtn()} onClick={() => setMode(mode === "raw" ? "render" : "raw")}>
                {mode === "raw" ? (isMd ? "Rendered" : "Preview") : isMd ? "Raw" : "Source"}
              </button>
            )}
            <button style={ghostBtn()} onClick={() => onOpenFile(selected)}>Open</button>
          </div>
          {mode === "render" && isHtml && content ? (
            <iframe title="HTML preview" sandbox="allow-scripts" srcDoc={content} style={{ flex: 1, border: "none", background: "#fff" }} />
          ) : mode === "render" && isMd && content ? (
            <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 10, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{content}</pre>
          ) : (
            <pre
              style={{
                flex: 1,
                overflow: "auto",
                margin: 0,
                padding: 10,
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                lineHeight: 1.55,
                color: "var(--orvyn-text-secondary)",
                whiteSpace: "pre-wrap",
              }}
            >
              {content ?? (selectedFile?.kind === "artifact" ? "Artifact listed. Open to inspect." : "…")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
