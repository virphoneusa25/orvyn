import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "../../connection";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceFile } from "../../agentWorkspaceModel";
import { searchFileTree, shouldShowBadge, type WorkbenchFileSection } from "../../workbenchFiles";
import { composeWorkbenchFileTree, resolveProjectFetchRoot } from "../../workbenchFileProviders";
import type { WorkbenchEnvironment } from "../../workbenchEnvironment";
import { environmentLabel } from "../../workbenchEnvironment";
import {
  fileReadPlan,
  previewKind,
  toWorkbenchFileItem,
  userFacingFileError,
  type WorkbenchFileItem,
} from "../../workbenchFileAccess";
import { IconChevronRight, IconFile, IconFolder, IconImage, IconSearch } from "../Icons";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

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
  focus?: { path?: string; fileName?: string; artifactId?: string } | null;
  activePath?: string | null;
  environment?: WorkbenchEnvironment;
  onOpenFile: (path: string) => void;
  onPreviewArtifact?: (name: string, artifactId?: string) => void;
}) {
  const [locations, setLocations] = useState<Array<{ id?: string; label?: string; files?: Record<string, unknown>[] }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url?: string; text?: string; error?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ project: true, generated: true, artifacts: true, uploads: true });

  const extras = useMemo(
    () =>
      [...files, ...artifacts].map((f) => ({
        name: f.path.split(/[\\/]/).pop() || f.path,
        path: f.path,
        source: f.kind === "artifact" ? "artifact" as const : "local" as const,
        kind: f.kind,
        artifactId: f.artifactId,
        id: f.artifactId,
        mimeType: f.mimeType,
      })),
    [files, artifacts]
  );

  useEffect(() => {
    let alive = true;
    const usableRoot = resolveProjectFetchRoot(projectRoot, isCloudBackend(getConnectionConfig().backendUrl));
    const suffix = usableRoot ? `?projectRoot=${encodeURIComponent(usableRoot)}` : "";
    fetch(apiUrl("/files" + suffix), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setLocations(Array.isArray(d.locations) ? d.locations : []);
        setLoadError(null);
      })
      .catch(() => {
        if (alive) setLoadError("Could not load workspace files. Generated artifacts still appear after a run.");
      });
    return () => {
      alive = false;
    };
  }, [projectRoot, artifacts.length, files.length]);

  const tree = useMemo(
    () => composeWorkbenchFileTree({ environment, projectRoot, locations, extras }),
    [locations, extras, environment, projectRoot]
  );
  const merged: WorkbenchFileSection[] = tree.sections.filter((s) => s.id !== "recents" && s.id !== "downloads");
  const allFiles = useMemo(() => searchFileTree({ ...tree, sections: merged }, query), [tree, merged, query]);
  const items = useMemo(() => allFiles.map((f) => toWorkbenchFileItem(f)), [allFiles]);

  const selected = items.find((i) => itemKey(i) === selectedKey) ?? null;

  useEffect(() => {
    if (focus?.artifactId) {
      const hit = items.find((i) => i.artifactId === focus.artifactId);
      if (hit) setSelectedKey(itemKey(hit));
      return;
    }
    if (focus) {
      const hit = items.find((i) => matchesFile(i.name, focus) || matchesFile(i.path ?? "", focus) || matchesFile(i.reference ?? "", focus));
      if (hit) setSelectedKey(itemKey(hit));
    }
  }, [focus, items]);

  useEffect(() => {
    if (!activePath) return;
    const hit = items.find((i) => i.path === activePath || i.name === activePath || i.reference === activePath);
    if (hit) setSelectedKey(itemKey(hit));
  }, [activePath, items]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    const plan = fileReadPlan(selected);
    let alive = true;
    setPreview(null);
    if (plan.via === "none") {
      setPreview({ error: selected.kind === "workspace-file" ? "Could not open this file." : "Artifact unavailable" });
      return;
    }
    const q =
      plan.via === "artifact" && plan.artifactId
        ? `/files/read?id=${encodeURIComponent(plan.artifactId)}`
        : `/files/read?path=${encodeURIComponent(plan.path ?? "")}${projectRoot ? `&projectRoot=${encodeURIComponent(projectRoot)}` : ""}`;
    fetch(apiUrl(q), { headers: authHeaders() })
      .then(async (r) => {
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) {
          setPreview({ error: userFacingFileError(d.error || "Artifact unavailable") });
          return;
        }
        if (d.dataUrl) setPreview({ url: d.dataUrl });
        else if (typeof d.content === "string") setPreview({ text: d.content.slice(0, 20_000) });
        else if (selected.previewUrl) setPreview({ url: apiUrl(selected.previewUrl) });
        else setPreview({ error: previewKind(selected.mimeType, selected.name) === "image" ? "Artifact unavailable" : "No preview for this file." });
      })
      .catch((err) => {
        if (alive) setPreview({ error: userFacingFileError(err) });
      });
    return () => {
      alive = false;
    };
  }, [selectedKey, selected?.artifactId, selected?.path, projectRoot]);

  async function downloadSelected() {
    if (!selected) return;
    const url = selected.downloadUrl || (selected.artifactId ? `/artifacts/${selected.artifactId}/download` : null);
    if (!url) return;
    const r = await fetch(apiUrl(url), { headers: authHeaders() });
    if (!r.ok) return;
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = selected.name;
    a.click();
    URL.revokeObjectURL(href);
  }

  function openSelected() {
    if (!selected) return;
    if (selected.kind === "workspace-file" && selected.path) onOpenFile(selected.path);
    else onPreviewArtifact?.(selected.name, selected.artifactId);
  }

  const projectLabel =
    environment === "cloud" ? "Project · Cloud" : environment === "sandbox" ? "Project · Sandbox" : "Project · Local";

  return (
    <div data-testid="workbench-files" style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <aside style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--orvyn-border-soft)", display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)" }}>
        <div style={{ padding: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 8, padding: "5px 8px" }}>
            <IconSearch size={12} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files…"
              style={{ flex: 1, background: "transparent", border: "none", color: "var(--orvyn-text)", fontSize: 11, outline: "none" }}
            />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 10px" }}>
          {!tree.hasProject && (
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: "6px 8px 10px" }}>
              {loadError || "No project workspace attached."}
            </div>
          )}
          {merged.map((loc) => {
            const open = openSections[loc.id] !== false;
            return (
              <div key={loc.id} style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setOpenSections((s) => ({ ...s, [loc.id]: !open }))}
                  style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "transparent", border: "none", color: "var(--orvyn-text-muted)", padding: "6px 6px", cursor: "pointer", fontSize: 10, letterSpacing: 0.7 }}
                >
                  <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-flex" }}><IconChevronRight size={10} /></span>
                  {loc.id === "project" ? projectLabel.toUpperCase() : loc.label.toUpperCase()}
                  <span style={{ opacity: 0.7 }}>{loc.files.length}</span>
                </button>
                {open && loc.files.length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: "2px 10px 8px" }}>
                    {loc.id === "project" ? "Open a folder to browse project files." : "Empty"}
                  </div>
                )}
                {open &&
                  loc.files.map((f) => {
                    const item = toWorkbenchFileItem(f);
                    const live = itemKey(item) === selectedKey;
                    const image = previewKind(item.mimeType, item.name) === "image";
                    return (
                      <button
                        key={`${loc.id}:${item.id}`}
                        data-file-kind={item.kind}
                        data-artifact-id={item.artifactId ?? ""}
                        onClick={() => setSelectedKey(itemKey(item))}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          background: live ? "rgba(77,163,255,0.12)" : "transparent",
                          border: "none",
                          borderRadius: 6,
                          padding: "5px 8px",
                          cursor: "pointer",
                          color: "var(--orvyn-text)",
                          textAlign: "left",
                        }}
                      >
                        <span style={{ color: image ? "var(--orvyn-cyan)" : "var(--orvyn-text-muted)", display: "inline-flex" }}>
                          {image ? <IconImage size={13} /> : loc.id === "project" ? <IconFolder size={13} /> : <IconFile size={13} />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                          {item.kind !== "workspace-file" && (
                            <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>
                              {(item.mimeType?.split("/")[1] || item.name.split(".").pop() || "file").toUpperCase()}
                              {item.bytes ? ` · ${item.bytes < 1024 ? `${item.bytes} B` : `${(item.bytes / 1024).toFixed(1)} KB`}` : ""}
                            </span>
                          )}
                        </span>
                        {shouldShowBadge(loc.id, f.badge, tree.environment !== "local") && (
                          <span style={{ fontSize: 9, color: "var(--orvyn-text-muted)" }}>{f.badge}</span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </aside>
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!selected ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
            <div style={emptyTitle()}>Select a file</div>
            <div style={emptyBody()}>Workspace files, generated artifacts, and uploads preview here.</div>
          </div>
        ) : (
          <ArtifactPreviewPane
            item={selected}
            preview={preview}
            environmentLabel={selected.kind === "workspace-file" ? projectLabel : selected.kind === "upload" ? "Uploads" : "Generated"}
            onOpen={openSelected}
            onDownload={() => void downloadSelected()}
            onReveal={() => {
              if (selected.kind === "workspace-file") return;
              onPreviewArtifact?.(selected.name, selected.artifactId);
            }}
          />
        )}
      </main>
    </div>
  );
}

function itemKey(item: WorkbenchFileItem): string {
  return item.artifactId ? `art:${item.artifactId}` : `path:${item.path ?? item.name}`;
}

function ArtifactPreviewPane({
  item,
  preview,
  environmentLabel,
  onOpen,
  onDownload,
  onReveal,
}: {
  item: WorkbenchFileItem;
  preview: { url?: string; text?: string; error?: string } | null;
  environmentLabel: string;
  onOpen: () => void;
  onDownload: () => void;
  onReveal: () => void;
}) {
  const kind = previewKind(item.mimeType, item.name);
  const typeLabel = (item.mimeType?.split("/")[1] || item.name.split(".").pop() || "file").toUpperCase();
  const size = item.bytes
    ? item.bytes < 1024
      ? `${item.bytes} B`
      : `${(item.bytes / 1024).toFixed(1)} KB`
    : null;

  return (
    <div data-testid="workbench-file-preview" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 18px 8px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
          <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 4 }}>
            {environmentLabel}
            {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString()}` : ""}
          </div>
        </div>
        {item.kind !== "workspace-file" && (
          <span style={{ fontSize: 10, letterSpacing: 0.6, color: "var(--orvyn-cyan)", border: "1px solid rgba(34,211,238,0.35)", borderRadius: 999, padding: "3px 8px" }}>
            GENERATED
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
        {preview?.error ? (
          <div style={{ textAlign: "center" }}>
            <div style={emptyTitle()}>{preview.error}</div>
            <div style={emptyBody()}>This is not a project file. ORVYN will not look it up on disk.</div>
          </div>
        ) : kind === "image" && preview?.url ? (
          <img src={preview.url} alt={item.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : kind === "pdf" && preview?.url ? (
          <iframe title={item.name} src={preview.url} style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "#fff" }} />
        ) : kind === "text" && preview?.text != null ? (
          <pre style={{ margin: 0, width: "100%", height: "100%", overflow: "auto", padding: 12, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {preview.text}
          </pre>
        ) : preview == null ? (
          <div style={{ color: "var(--orvyn-text-muted)", fontSize: 12 }}>Loading…</div>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div style={emptyTitle()}>{typeLabel}</div>
            <div style={emptyBody()}>Download this file to inspect it.</div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--orvyn-border-soft)" }}>
        <button style={ghostBtn()} onClick={onOpen}>Open</button>
        <button style={ghostBtn()} onClick={onDownload} disabled={!item.artifactId && !item.downloadUrl}>Download</button>
        {item.kind !== "workspace-file" && <button style={ghostBtn()} onClick={onReveal}>Show in Files</button>}
        <button
          style={ghostBtn()}
          onClick={() => {
            const ref = item.reference || item.name;
            void navigator.clipboard?.writeText(ref);
          }}
        >
          Copy reference
        </button>
      </div>
      <div style={{ padding: "8px 16px 14px", fontSize: 11, color: "var(--orvyn-text-muted)", display: "grid", gridTemplateColumns: "88px 1fr", gap: "4px 10px" }}>
        <span>Reference</span>
        <code>{item.reference || item.name}</code>
        <span>Type</span>
        <span>{item.mimeType || typeLabel}</span>
        {size && <><span>Size</span><span>{size}</span></>}
        <span>Source</span>
        <span>{item.kind === "workspace-file" ? environmentLabel : "ArtifactService"}</span>
      </div>
    </div>
  );
}
