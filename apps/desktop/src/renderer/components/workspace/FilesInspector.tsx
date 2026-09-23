import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "../../connection";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceFile } from "../../agentWorkspaceModel";
import { mergeFileSections, shouldShowBadge, type WorkbenchFileSection } from "../../workbenchFiles";
import type { WorkbenchEnvironment } from "../../workbenchEnvironment";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

interface TreeFile {
  id?: string;
  name: string;
  path: string;
  kind: string;
  mediaType?: string | null;
  createdAt?: number;
  bytes?: number;
  downloadUrl?: string;
  badge?: string;
}

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
  environment = "local",
  onOpenFile,
  onPreviewArtifact,
}: {
  files: WorkspaceFile[];
  artifacts: WorkspaceFile[];
  projectRoot: string | null;
  focus?: { path?: string; fileName?: string } | null;
  activePath?: string | null;
  environment?: WorkbenchEnvironment;
  onOpenFile: (path: string) => void;
  onPreviewArtifact?: (path: string) => void;
}) {
  const [locations, setLocations] = useState<Array<{ id?: string; label?: string; files?: Record<string, unknown>[] }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(activePath ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"raw" | "render">("raw");
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const runTouched = useMemo(() => {
    const map = new Map<string, WorkspaceFile>();
    for (const f of files) map.set(f.path, f);
    for (const a of artifacts) map.set(a.path, a);
    return [...map.values()];
  }, [files, artifacts]);

  useEffect(() => {
    let alive = true;
    const cloud = isCloudBackend(getConnectionConfig().backendUrl);
    const foreign = Boolean(projectRoot && (/^[A-Za-z]:[\\/]/.test(projectRoot) || projectRoot.startsWith("\\\\")));
    const usableRoot = projectRoot && !(cloud && foreign) ? projectRoot : null;
    const suffix = usableRoot ? `?projectRoot=${encodeURIComponent(usableRoot)}` : "";
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

  const tree = useMemo(() => mergeFileSections(
    locations,
    environment,
    runTouched.map((f) => ({
      name: f.path.split(/[\\/]/).pop() || f.path,
      path: f.path,
      source: f.kind === "artifact" ? "artifact" : "local",
      kind: f.kind,
    }))
  ), [locations, runTouched, environment]);
  const merged: WorkbenchFileSection[] = tree.sections;

  const allFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    const files = merged.flatMap((l) => l.files);
    if (!q) return files;
    return files.filter((f) =>
      f.name.toLowerCase().includes(q) ||
      (f.mediaType ?? "").toLowerCase().includes(q) ||
      (f.kind ?? "").toLowerCase().includes(q)
    );
  }, [merged, query]);

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

  async function deleteSelected() {
    const file = selectedFile;
    if (!file?.id) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const r = await fetch(apiUrl(`/artifacts/${file.id}`), { method: "DELETE", headers: authHeaders() });
    if (r.ok || r.status === 204) {
      setLocations((prev) => prev.map((loc) => ({ ...loc, files: (loc.files ?? []).filter((f) => f.id !== file.id) })));
      setSelected(null);
      setSelectedId(null);
    }
    setConfirmDelete(false);
  }

  if (total === 0 && !query) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12 }}>
        {!tree.hasProject && (
          <div style={{ padding: "10px 12px", border: "1px dashed var(--orvyn-border-soft)", borderRadius: 8 }}>
            <div style={emptyTitle()}>No project workspace attached</div>
            <div style={emptyBody()}>{loadError || "Generated artifacts, uploads, and run files still appear below."}</div>
          </div>
        )}
        {merged.filter((l) => l.id !== "project").map((loc) => (
          <div key={loc.id}>
            <div style={{ fontSize: 10, letterSpacing: 0.8, color: "var(--orvyn-text-muted)" }}>{loc.label.toUpperCase()}</div>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: "6px 0" }}>Empty</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 8px 0" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files and artifacts"
          style={{ width: "100%", fontSize: 11, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--orvyn-border-soft)", background: "transparent", color: "var(--orvyn-text)" }}
        />
      </div>
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
                    {shouldShowBadge(loc.id, f.badge, tree.environment !== "local") && (
                      <span style={{ fontSize: 9, color: "var(--orvyn-text-muted)", letterSpacing: 0.4 }}>{f.badge}</span>
                    )}
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
            {selectedFile?.id && (
              <button style={ghostBtn()} onClick={() => void deleteSelected()}>{confirmDelete ? "Confirm delete" : "Delete"}</button>
            )}
          </div>
          {selectedFile && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", padding: "6px 8px 0", display: "flex", flexWrap: "wrap", gap: 10 }}>
              <span>{selectedFile.mediaType || selectedFile.kind}</span>
              {selectedFile.bytes ? <span>{selectedFile.bytes < 1024 ? `${selectedFile.bytes} B` : `${(selectedFile.bytes / 1024).toFixed(1)} KB`}</span> : null}
              {selectedFile.createdAt ? <span>{new Date(selectedFile.createdAt).toLocaleString()}</span> : null}
              {selectedFile.id ? <span>id {selectedFile.id}</span> : null}
            </div>
          )}
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
