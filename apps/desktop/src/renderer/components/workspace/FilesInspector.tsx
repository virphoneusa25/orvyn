import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceFile } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

type LocationId = "project" | "generated" | "downloads" | "artifacts" | "uploads" | "run";

interface TreeFile {
  id?: string;
  name: string;
  path: string;
  kind: string;
  mediaType?: string | null;
  createdAt?: number;
  bytes?: number;
  downloadUrl?: string;
}

interface Location {
  id: LocationId | string;
  label: string;
  files: TreeFile[];
}

const LOCATION_ORDER: { id: string; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "generated", label: "Generated" },
  { id: "downloads", label: "Downloads" },
  { id: "artifacts", label: "Run Artifacts" },
  { id: "uploads", label: "Uploads" },
];

function kindMark(kind: string): { glyph: string; color: string } {
  if (kind === "created" || kind === "generated") return { glyph: "＋", color: "var(--orvyn-green)" };
  if (kind === "deleted") return { glyph: "−", color: "var(--orvyn-red)" };
  if (kind === "artifact" || kind === "document" || kind === "run") return { glyph: "▣", color: "var(--orvyn-cyan)" };
  if (kind === "download") return { glyph: "↓", color: "var(--orvyn-cyan)" };
  if (kind === "upload") return { glyph: "↑", color: "var(--orvyn-purple-hi, #6C5CFF)" };
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
  const [locations, setLocations] = useState<Location[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(activePath ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"raw" | "render">("raw");

  const runTouched = useMemo(() => {
    const map = new Map<string, WorkspaceFile>();
    for (const f of files) map.set(f.path, f);
    for (const a of artifacts) map.set(a.path, a);
    return [...map.values()];
  }, [files, artifacts]);

  useEffect(() => {
    let alive = true;
    const suffix = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
    fetch(apiUrl("/files" + suffix), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setLocations(Array.isArray(d.locations) ? d.locations : []);
        setLoadError(null);
      })
      .catch(() => {
        if (alive) setLoadError("Could not load files. Generated artifacts still appear after a run.");
      });
    return () => {
      alive = false;
    };
  }, [projectRoot, artifacts.length, files.length]);

  const merged = useMemo(() => {
    const byId = new Map<string, Location>();
    for (const loc of LOCATION_ORDER) byId.set(loc.id, { id: loc.id, label: loc.label, files: [] });
    for (const loc of locations) {
      const id = loc.id === "run" ? "artifacts" : loc.id;
      const existing = byId.get(id) ?? { id, label: loc.label, files: [] };
      existing.files = [...existing.files, ...loc.files];
      existing.label = loc.label || existing.label;
      byId.set(id, existing);
    }
    const project = byId.get("project");
    if (project) {
      for (const f of runTouched) {
        if (project.files.some((p) => p.path === f.path)) continue;
        if (f.kind === "artifact") {
          const arts = byId.get("artifacts")!;
          if (!arts.files.some((p) => p.path === f.path)) arts.files.push({ name: f.path.split(/[\\/]/).pop() || f.path, path: f.path, kind: "artifact" });
        } else {
          project.files.push({ name: f.path.split(/[\\/]/).pop() || f.path, path: f.path, kind: f.kind });
        }
      }
    }
    return LOCATION_ORDER.map((l) => byId.get(l.id)!).filter(Boolean);
  }, [locations, runTouched]);

  const allFiles = useMemo(() => merged.flatMap((l) => l.files), [merged]);

  useEffect(() => {
    if (activePath) setSelected(activePath);
  }, [activePath]);

  useEffect(() => {
    if (!focus) return;
    const hit = allFiles.find((f) => matchesFile(f.path, focus) || matchesFile(f.name, focus));
    if (hit) {
      setSelected(hit.path);
      setSelectedId(hit.id ?? null);
    }
  }, [focus, allFiles]);

  useEffect(() => {
    if (!selected) return;
    const file = allFiles.find((f) => f.path === selected);
    const ext = (file?.name || selected).split(".").pop()?.toLowerCase() ?? "";
    const image = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
    setPreviewUrl(null);
    setContent(null);
    let alive = true;
    const q = file?.id
      ? `/files/read?id=${encodeURIComponent(file.id)}`
      : `/files/read?path=${encodeURIComponent(selected)}${projectRoot ? `&projectRoot=${encodeURIComponent(projectRoot)}` : ""}`;
    fetch(apiUrl(q), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.dataUrl) setPreviewUrl(d.dataUrl);
        else if (d.content) setContent(String(d.content).slice(0, 20_000));
        else if (image) setContent(null);
        else setContent(d.error ? `Could not read: ${d.error}` : "File listed. Open or download to inspect.");
      })
      .catch(() => alive && setContent("Could not read this file."));
    return () => {
      alive = false;
    };
  }, [selected, selectedId, projectRoot, allFiles]);

  const total = allFiles.length;
  const selectedFile = allFiles.find((f) => f.path === selected);
  const ext = (selectedFile?.name || selected || "").split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);

  async function downloadSelected() {
    const file = selectedFile;
    if (!file) return;
    const url = file.downloadUrl || (file.id ? `/artifacts/${file.id}/download` : null);
    if (!url) {
      onOpenFile(file.path);
      return;
    }
    const r = await fetch(apiUrl(url), { headers: authHeaders() });
    if (!r.ok) return;
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(href);
  }

  if (total === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No files yet</div>
        <div style={emptyBody()}>
          {loadError || "Ask ORION to generate a logo, write a document, or open a project folder. Files appear here in Project, Generated, Downloads, and Run Artifacts — no local folder required."}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 42%", minHeight: 120, overflowY: "auto", borderBottom: "1px solid var(--orvyn-border-soft)", padding: "6px 8px" }}>
        {merged.map((loc) => (
          <div key={loc.id} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, letterSpacing: 0.8, color: "var(--orvyn-text-muted)", padding: "4px 4px 6px" }}>
              {loc.label.toUpperCase()}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>{loc.files.length}</span>
            </div>
            {loc.files.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: "2px 6px 8px" }}>
                {loc.id === "project" ? "No project files. Open a folder or work in the virtual workspace." : "Empty"}
              </div>
            ) : (
              loc.files.map((f) => {
                const mark = kindMark(f.kind);
                const live = f.path === selected;
                return (
                  <button
                    key={`${loc.id}:${f.id ?? f.path}`}
                    onClick={() => {
                      setSelected(f.path);
                      setSelectedId(f.id ?? null);
                      if (f.kind === "artifact" || f.id) onPreviewArtifact?.(f.path);
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
                    <code style={{ flex: 1, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</code>
                  </button>
                );
              })
            )}
          </div>
        ))}
      </div>
      {selected && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
            <code style={{ flex: 1, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{selectedFile?.name ?? selected}</code>
            {(isMd || isHtml) && (
              <button style={ghostBtn()} onClick={() => setMode(mode === "raw" ? "render" : "raw")}>
                {mode === "raw" ? (isMd ? "Rendered" : "Preview") : isMd ? "Raw" : "Source"}
              </button>
            )}
            <button style={ghostBtn()} onClick={() => void downloadSelected()}>Download</button>
            <button style={ghostBtn()} onClick={() => onOpenFile(selected)}>Open</button>
          </div>
          {isImage && previewUrl ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 12 }}>
              <img src={previewUrl} alt={selectedFile?.name ?? selected} style={{ maxWidth: "100%", maxHeight: "100%" }} />
            </div>
          ) : mode === "render" && isHtml && content ? (
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
              {content ?? (isImage ? "Image listed. Download or open to inspect." : "…")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
