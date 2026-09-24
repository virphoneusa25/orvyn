// apps/desktop/src/renderer/components/workspace/FilesInspector.tsx
//
// Workbench Files tab. One colour-coded card says WHERE the files live —
// your computer (teal) or ORVYN Cloud (indigo) — and everything below follows
// from it: ORION's changes first, then a real folder tree, generated files,
// and a preview whose buttons match the location. Local project files are read
// straight from this computer; nothing here lists a server copy as "Local".

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import { guessLanguage } from "./FileEditorView";
import { centerFileView, useCenterFileView } from "../../centerFileView";
import { apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "../../connection";
import { matchesFile } from "../../contextOpen";
import type { WorkspaceFile } from "../../agentWorkspaceModel";
import { composeWorkbenchFileTree, resolveProjectFetchRoot } from "../../workbenchFileProviders";
import type { WorkbenchEnvironment } from "../../workbenchEnvironment";
import { isBuiltInWorkspace } from "../../orvynCommand";
import {
  fileBasename,
  fileReadPlan,
  isFabricatedGeneratedPath,
  matchArtifactId,
  needsArtifactNameLookup,
  previewFailureNote,
  previewKind,
  toWorkbenchFileItem,
  userFacingFileError,
  type WorkbenchFileItem,
} from "../../workbenchFileAccess";
import {
  baseName,
  buildTree,
  changedByOrion,
  directoryNodes,
  filterTree,
  formatBytes,
  locationCopy,
  previewFooter,
  resolveFilesLocation,
  toProjectRelative,
  typeLabel,
  type ChangedFile,
  type FilesLocation,
  type TreeNode,
} from "../../filesPanelModel";
import { IconChevronRight, IconCloud, IconFolder, IconMonitor, IconSearch } from "../Icons";
import { FileTypeIcon } from "../FileTypeIcon";

type Selection =
  | { kind: "project"; path: string; bytes?: number }
  | { kind: "item"; item: WorkbenchFileItem };

interface PreviewState {
  /** The file is not on this computer; this is ORVYN Cloud's copy. */
  cloudCopy?: boolean;
  url?: string;
  text?: string;
  error?: string;
  note?: string;
  artifactId?: string;
  bytes?: number;
}

type WorkerState = "ready" | "degraded" | "offline" | null;

export function FilesInspector({
  files,
  artifacts,
  projectRoot,
  focus,
  activePath,
  environment = "local",
  onOpenFile,
  onPreviewArtifact,
  onOpenChanges,
}: {
  files: WorkspaceFile[];
  artifacts: WorkspaceFile[];
  projectRoot: string | null;
  focus?: { path?: string; fileName?: string; artifactId?: string } | null;
  activePath?: string | null;
  environment?: WorkbenchEnvironment;
  onOpenFile: (path: string) => void;
  onPreviewArtifact?: (name: string, artifactId?: string) => void;
  onOpenChanges?: (path: string) => void;
}) {
  const cloudBackend = isCloudBackend(getConnectionConfig().backendUrl);
  const derivedLocation: FilesLocation = resolveFilesLocation({
    environment,
    projectRoot,
    cloudBackend,
    builtInWorkspace: isBuiltInWorkspace(projectRoot),
  });
  // With a project open on a cloud backend, both places are real: the folder
  // on this computer and the ORVYN Cloud workspace. Let the user look at either.
  const canSwitch = cloudBackend && Boolean(projectRoot) && !isBuiltInWorkspace(projectRoot) && derivedLocation !== "sandbox";
  const [viewOverride, setViewOverride] = useState<FilesLocation | null>(null);
  useEffect(() => { setViewOverride(null); }, [projectRoot, environment]);
  const location: FilesLocation = canSwitch && viewOverride ? viewOverride : derivedLocation;
  const localProject = location === "local" && Boolean(projectRoot);

  // --- Local Worker state (only meaningful when a cloud backend drives this computer)
  const [workerState, setWorkerState] = useState<WorkerState>(null);
  useEffect(() => {
    if (location !== "local" || !cloudBackend || !window.orvyn?.localWorker) return;
    let alive = true;
    const read = () => window.orvyn.localWorker!.status().then((s) => alive && setWorkerState(s.state)).catch(() => alive && setWorkerState(null));
    void read();
    const t = window.setInterval(read, 15_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [location, cloudBackend]);
  const copy = locationCopy(location, { projectRoot, workerState: cloudBackend ? workerState : "ready" });

  // --- ORION's changes this run
  const changed = useMemo(() => changedByOrion(files, projectRoot), [files, projectRoot]);
  const changedByPath = useMemo(() => new Map(changed.map((c) => [c.path, c])), [changed]);
  // The Changes view is keyed by the path exactly as the run reported it.
  const originalPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) if (f?.path) m.set(toProjectRelative(f.path, projectRoot), f.path);
    return m;
  }, [files, projectRoot]);

  // --- Server listing: generated files and uploads always; project files only for Cloud / Sandbox
  const [locations, setLocations] = useState<Array<{ id?: string; label?: string; files?: Record<string, unknown>[] }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const usableRoot = location === "local" ? null : resolveProjectFetchRoot(projectRoot, cloudBackend);
    const suffix = usableRoot ? `?projectRoot=${encodeURIComponent(usableRoot)}` : "";
    fetch(apiUrl("/files" + suffix), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) { setLocations(Array.isArray(d.locations) ? d.locations : []); setLoadError(null); } })
      .catch(() => { if (alive) setLoadError("Could not reach ORVYN Cloud to list files."); });
    return () => { alive = false; };
  }, [projectRoot, location, cloudBackend, artifacts.length, files.length]);

  const extras = useMemo(
    () => artifacts.map((f) => ({
      name: f.path.split(/[\\/]/).pop() || f.path, path: f.path, source: "artifact" as const, kind: f.kind,
      artifactId: f.artifactId, id: f.artifactId, mimeType: f.mimeType,
    })),
    [artifacts]
  );
  const serverTree = useMemo(
    () => composeWorkbenchFileTree({ environment: location === "sandbox" ? "sandbox" : location === "cloud" ? "cloud" : "local", projectRoot, locations, extras }),
    [locations, extras, location, projectRoot]
  );
  const generatedItems = useMemo(
    () => serverTree.sections
      .filter((s) => s.id === "generated" || s.id === "artifacts" || s.id === "uploads")
      .flatMap((s) => s.files.map((f) => toWorkbenchFileItem(f))),
    [serverTree]
  );
  const cloudProjectEntries = useMemo(
    () => location === "local" ? [] : (serverTree.sections.find((s) => s.id === "project")?.files ?? []),
    [serverTree, location]
  );

  // --- Project tree: this computer's disk for Local, the server listing otherwise
  const [dirCache, setDirCache] = useState<Record<string, TreeNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);
  const loadDir = useCallback(async (dir: string) => {
    if (!localProject || !window.orvyn?.project?.listDirectory) return;
    try {
      const entries = await window.orvyn.project.listDirectory(dir || ".");
      setDirCache((c) => ({ ...c, [dir]: directoryNodes(dir, entries) }));
      setLocalError(null);
    } catch (err: any) {
      if (!dir) setLocalError(userFacingFileError(err));
    }
  }, [localProject]);
  useEffect(() => { setDirCache({}); setExpanded(new Set()); }, [projectRoot]);
  // Reload the open folders whenever ORION changes something.
  useEffect(() => {
    if (!localProject) return;
    void loadDir("");
    expanded.forEach((d) => void loadDir(d));
  }, [localProject, loadDir, changed.length, files.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [query, setQuery] = useState("");
  const cloudTree = useMemo(() => buildTree(cloudProjectEntries.map((f) => ({ path: String(f.path || f.name), bytes: f.bytes }))), [cloudProjectEntries]);

  // --- Selection + preview
  const [selection, setSelection] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [saved, setSaved] = useState<{ path?: string; error?: string; info?: string } | null>(null);
  // Editing a file on this computer right in the center view.
  const [editing, setEditing] = useState<{ text: string; original: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const selectProject = useCallback((path: string, bytes?: number) => {
    setSelection({ kind: "project", path, bytes });
    setSaved(null);
    const parts = path.split("/");
    if (parts.length > 1 && localProject) {
      const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      setExpanded((e) => { const n = new Set(e); parents.forEach((p) => n.add(p)); return n; });
      parents.forEach((p) => void loadDir(p));
    }
  }, [localProject, loadDir]);

  // A file the user picks is shown in the center of the window.
  const center = useCenterFileView();
  const openProject = useCallback((path: string, bytes?: number) => {
    selectProject(path, bytes);
    centerFileView.open();
  }, [selectProject]);
  // Leaving the Files tab (or closing the panel) returns the center to the chat.
  useEffect(() => () => centerFileView.close(), []);
  useEffect(() => { if (!selection) centerFileView.close(); }, [selection]);

  // Open from the chat ("Wrote hello.txt · Open") lands on that exact file.
  useEffect(() => {
    if (!focus) return;
    if (focus.artifactId) {
      const hit = generatedItems.find((i) => i.artifactId === focus.artifactId);
      if (hit) { setSelection({ kind: "item", item: hit }); setSaved(null); centerFileView.open(); }
      return;
    }
    const target = focus.path || focus.fileName;
    if (!target) return;
    if (location === "local") return openProject(toProjectRelative(target, projectRoot));
    const hit = cloudProjectEntries.find((f) => matchesFile(String(f.path || f.name), focus));
    if (hit) return openProject(toProjectRelative(String(hit.path || hit.name)), hit.bytes);
    const gen = generatedItems.find((i) => matchesFile(i.name, focus) || matchesFile(i.path ?? "", focus));
    if (gen) { setSelection({ kind: "item", item: gen }); centerFileView.open(); }
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // With nothing chosen yet, open on the newest file ORION changed.
  useEffect(() => {
    if (selection) return;
    const first = changed.find((c) => c.status !== "deleted");
    if (first) selectProject(first.path);
    else if (activePath) selectProject(toProjectRelative(activePath, projectRoot));
  }, [changed, activePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const selName = selection ? (selection.kind === "project" ? baseName(selection.path) : selection.item.name) : "";
  const selKey = selection ? (selection.kind === "project" ? `p:${selection.path}` : `i:${selection.item.artifactId ?? selection.item.path ?? selection.item.name}`) : "";
  useEffect(() => { setEditing(null); setSaving(false); }, [selKey, location]);

  useEffect(() => {
    if (!selection) { setPreview(null); return; }
    let alive = true;
    setPreview(null);
    const done = (p: PreviewState) => { if (alive) setPreview(p); };
    const kind = previewKind(selection.kind === "item" ? selection.item.mimeType : null, selName);

    if (selection.kind === "project" && location === "local") {
      const bridge = window.orvyn?.project;
      if (!bridge) { done({ error: "This computer's files are only available in the ORVYN desktop app." }); return () => { alive = false; }; }
      if (kind === "image") {
        bridge.readBinary(selection.path)
          .then((a) => done(a?.dataUrl ? { url: a.dataUrl } : { error: "This image is too large to preview.", note: "Use Show in folder to open it." }))
          .catch((e) => done({ error: userFacingFileError(e) }));
      } else if (kind === "text") {
        const path = selection.path;
        bridge.readFile(path)
          .then((t) => done({ text: t.slice(0, 40_000), bytes: new Blob([t]).size }))
          .catch((e) => {
            const missing = /ENOENT|no such file|not found/i.test(String(e?.message ?? e));
            if (!missing) return done({ error: userFacingFileError(e) });
            if (!cloudBackend) return done({ error: "This file is not on your computer." });
            // ORION may have written it in ORVYN Cloud instead. Show that copy,
            // clearly labelled, so it can still be read and downloaded.
            fetch(apiUrl(`/files/read?path=${encodeURIComponent(path)}`), { headers: authHeaders() })
              .then(async (r) => {
                const body = await r.json().catch(() => ({}));
                if (r.ok && typeof body.content === "string") return done({ cloudCopy: true, text: body.content.slice(0, 40_000), bytes: body.bytes ?? new Blob([body.content]).size });
                if (r.ok && body.dataUrl) return done({ cloudCopy: true, url: body.dataUrl, bytes: body.bytes });
                done({ error: "This file is not on your computer or in ORVYN Cloud.", note: "ORION may have removed it after this run." });
              })
              .catch(() => done({ error: "This file is not on your computer.", note: "ORVYN Cloud could not be reached to look for a copy." }));
          });
      } else {
        done({ error: `${typeLabel(selName)} file`, note: "Use Open in editor or Show in folder to view it." });
      }
      return () => { alive = false; };
    }

    const readQuery = (q: string, artifactId?: string) => {
      fetch(apiUrl(q), { headers: authHeaders() })
        .then(async (r) => {
          const body = await r.json();
          const id = artifactId || body.artifact?.artifactId;
          if (!r.ok) return done({ error: userFacingFileError(body.error || "File unavailable"), note: previewFailureNote("read-failed"), artifactId: id });
          if (body.dataUrl) return done({ url: body.dataUrl, artifactId: id, bytes: body.bytes });
          if (typeof body.content === "string") return done({ text: body.content.slice(0, 40_000), artifactId: id, bytes: body.bytes ?? new Blob([body.content]).size });
          if (selection.kind === "item" && selection.item.previewUrl) return done({ url: apiUrl(selection.item.previewUrl), artifactId: id });
          done({ error: "No preview for this file.", artifactId: id });
        })
        .catch((err) => done({ error: userFacingFileError(err), note: previewFailureNote("read-failed"), artifactId }));
    };

    if (selection.kind === "project") {
      const root = resolveProjectFetchRoot(projectRoot, cloudBackend);
      readQuery(`/files/read?path=${encodeURIComponent(selection.path)}${root ? `&projectRoot=${encodeURIComponent(root)}` : ""}`);
      return () => { alive = false; };
    }

    const item = selection.item;
    const plan = fileReadPlan(item);
    if (plan.via === "artifact" && plan.artifactId) readQuery(`/files/read?id=${encodeURIComponent(plan.artifactId)}`, plan.artifactId);
    else if (needsArtifactNameLookup(item)) {
      const name = fileBasename(item.path || item.name);
      fetch(apiUrl(`/artifacts?q=${encodeURIComponent(name)}`), { headers: authHeaders() })
        .then((r) => r.json())
        .then((body) => {
          const id = matchArtifactId(Array.isArray(body.artifacts) ? body.artifacts : [], name);
          if (id) readQuery(`/files/read?id=${encodeURIComponent(id)}`, id);
          else done({ error: "Could not open this file.", note: previewFailureNote(isFabricatedGeneratedPath(item.path) ? "disk-refused" : "artifact-missing") });
        })
        .catch((err) => done({ error: userFacingFileError(err), note: previewFailureNote("read-failed") }));
    } else done({ error: "Could not open this file.", note: previewFailureNote("artifact-missing") });
    return () => { alive = false; };
  }, [selKey, location, projectRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Actions
  const selectedChange: ChangedFile | null = selection?.kind === "project" ? changedByPath.get(selection.path) ?? null : null;
  const isGenerated = selection?.kind === "item";
  const footerLoc: FilesLocation | "generated" = isGenerated ? "generated" : location;

  const canEdit =
    selection?.kind === "project" && location === "local" && !preview?.cloudCopy &&
    preview != null && !preview.error && preview.text != null && Boolean(window.orvyn?.project?.writeFile);
  const dirty = Boolean(editing && editing.text !== editing.original);

  async function startEditing() {
    if (!selection || selection.kind !== "project") return;
    setSaved(null);
    try {
      // Read the whole file again: the preview may be shortened for speed,
      // and saving a shortened copy would cut the file.
      const full = await window.orvyn.project.readFile(selection.path);
      setEditing({ text: full, original: full });
    } catch (err) {
      setSaved({ error: userFacingFileError(err) });
    }
  }

  const saveRef = React.useRef<() => void>(() => undefined);
  const codeEditorRef = React.useRef<{ focus(): void } | null>(null);
  useEffect(() => { if (editing) window.setTimeout(() => codeEditorRef.current?.focus(), 0); }, [Boolean(editing)]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveEdits() {
    if (!selection || selection.kind !== "project" || !editing || saving) return;
    setSaving(true);
    setSaved(null);
    try {
      const ok = await window.orvyn.project.writeFile(selection.path, editing.text);
      if (!ok) throw new Error("The file was not saved.");
      setPreview((p) => (p ? { ...p, text: editing.text.slice(0, 40_000), bytes: new Blob([editing.text]).size } : p));
      setEditing(null);
      setSaved({ info: "Saved to your computer." });
    } catch (err) {
      setSaved({ error: userFacingFileError(err) });
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => { if (dirty) void saveEdits(); };

  function leaveCenter() {
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    setEditing(null);
    centerFileView.close();
  }

  async function downloadToComputer() {
    if (!selection) return;
    setSaved(null);
    try {
      let base64 = "";
      if (selection.kind === "item") {
        const id = selection.item.artifactId || preview?.artifactId;
        const url = selection.item.downloadUrl || (id ? `/artifacts/${id}/download` : null);
        if (!url) throw new Error("This file has no download yet.");
        const r = await fetch(apiUrl(url), { headers: authHeaders() });
        if (!r.ok) throw new Error("ORVYN Cloud did not return the file.");
        base64 = await blobToBase64(await r.blob());
      } else if (preview?.url?.startsWith("data:")) {
        base64 = preview.url.slice(preview.url.indexOf(",") + 1);
      } else if (preview?.text != null) {
        base64 = textToBase64(preview.text);
      } else {
        throw new Error("Wait for the preview to load, then try again.");
      }
      if (window.orvyn?.files?.saveAs) {
        const res = await window.orvyn.files.saveAs({ defaultName: selName, base64 });
        if (res.ok) setSaved({ path: res.path });
        else if (!res.canceled) setSaved({ error: res.error || "The file was not saved." });
      } else {
        const a = document.createElement("a");
        a.href = `data:application/octet-stream;base64,${base64}`;
        a.download = selName;
        a.click();
        setSaved({ path: `Downloads\\${selName}` });
      }
    } catch (err: any) {
      setSaved({ error: userFacingFileError(err) });
    }
  }

  function toggleDir(path: string) {
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(path)) n.delete(path);
      else { n.add(path); if (localProject && !dirCache[path]) void loadDir(path); }
      return n;
    });
  }

  // --- Tree rendering
  const rootNodes: TreeNode[] = location === "local"
    ? withChildren(dirCache[""] ?? [], dirCache)
    : cloudTree;
  const visibleNodes = filterTree(rootNodes, query);
  const searching = query.trim().length > 0;
  const fileCount = countFiles(rootNodes);

  function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
    return nodes.map((n) => {
      const open = searching || expanded.has(n.path);
      const change = changedByPath.get(n.path);
      if (n.dir) {
        return (
          <React.Fragment key={`d:${n.path}`}>
            <button type="button" className="ofp-row ofp-dir" style={{ paddingLeft: 8 + depth * 16 }} aria-expanded={open} onClick={() => toggleDir(n.path)}>
              <span className="ofp-caret"><IconChevronRight size={11} /></span>
              <IconFolder size={14} />
              <span className="ofp-name">{n.name}</span>
            </button>
            {open && renderNodes(n.children ?? [], depth + 1)}
          </React.Fragment>
        );
      }
      return (
        <button
          type="button"
          key={`f:${n.path}`}
          className="ofp-row"
          style={{ paddingLeft: 26 + depth * 16 }}
          aria-current={selection?.kind === "project" && selection.path === n.path}
          onClick={() => openProject(n.path, n.bytes)}
        >
          <FileTypeIcon path={n.name} size={14} />
          <span className="ofp-name">{n.name}</span>
          <span className="ofp-meta">
            {change && <span className="ofp-by">ORION</span>}
            {formatBytes(n.bytes)}
          </span>
        </button>
      );
    });
  }

  return (
    <div data-testid="workbench-files" className={`ofp ofp--${location}`}>
      <div className="ofp-scroll">
        <div className="ofp-where" data-testid="files-location" data-location={location}>
          <span className="ofp-where__icon">{location === "cloud" ? <IconCloud size={17} /> : <IconMonitor size={17} />}</span>
          <span className="ofp-where__text">
            <b>{copy.title}</b>
            <span className="ofp-where__path" title={copy.detail}>{copy.detail}</span>
          </span>
          <span className={`ofp-where__state ofp-tone-${copy.tone}`}><i />{copy.state}</span>
        </div>
        {canSwitch && (
          <div className="ofp-switch" role="tablist" aria-label="Which files to show">
            <button type="button" role="tab" aria-selected={location === "local"} className="is-local" onClick={() => { setViewOverride("local"); setSelection(null); centerFileView.close(); }}>
              <IconMonitor size={13} />Your computer
            </button>
            <button type="button" role="tab" aria-selected={location === "cloud"} className="is-cloud" onClick={() => { setViewOverride("cloud"); setSelection(null); centerFileView.close(); }}>
              <IconCloud size={13} />ORVYN Cloud
            </button>
          </div>
        )}
        <p className="ofp-note">{copy.note}</p>

        <label className="ofp-search">
          <IconSearch size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={location === "cloud" ? "Search files in the cloud workspace" : "Search files in this project"}
            aria-label="Search files"
          />
        </label>

        {changed.length > 0 && !searching && (
          <section aria-label="Changed by ORION">
            <div className="ofp-sec"><span>Changed by ORION</span><span>this run</span></div>
            {changed.map((c) => (
              <button
                type="button"
                key={`c:${c.path}`}
                className="ofp-row"
                aria-current={selection?.kind === "project" && selection.path === c.path}
                onClick={() => openProject(c.path)}
                disabled={c.status === "deleted"}
              >
                <FileTypeIcon path={c.name} size={14} />
                <span className="ofp-name">{c.name}<small>{c.status === "new" ? "new" : c.status === "deleted" ? "deleted" : c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "edited"}</small></span>
                <span className="ofp-meta">
                  {(c.additions > 0 || c.deletions > 0) && (
                    <span className="ofp-chg">{c.additions > 0 ? `+${c.additions}` : ""}{c.deletions > 0 ? ` −${c.deletions}` : ""}</span>
                  )}
                </span>
              </button>
            ))}
          </section>
        )}

        <section aria-label={location === "cloud" ? "Cloud workspace files" : "Project files"}>
          <div className="ofp-sec"><span>{location === "cloud" ? "Cloud workspace" : "Project"}</span><span>{fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}</span></div>
          {location === "local" && !projectRoot && <p className="ofp-empty">Open a project folder to see its files here.</p>}
          {location === "local" && projectRoot && localError && <p className="ofp-empty">{localError}</p>}
          {location !== "local" && loadError && <p className="ofp-empty">{loadError}</p>}
          {visibleNodes.length === 0 && (location !== "local" || (projectRoot && !localError)) && !loadError && (
            <p className="ofp-empty">{searching ? "No files match your search." : location === "cloud" ? "The cloud workspace is empty. Files ORION creates appear here." : "This folder is empty."}</p>
          )}
          {renderNodes(visibleNodes, 0)}
        </section>

        {generatedItems.length > 0 && !searching && (
          <section aria-label="Generated files">
            <div className="ofp-sec"><span>Generated</span><span>stored in ORVYN Cloud</span></div>
            <div className="ofp-gen">
              {generatedItems.map((g) => (
                <button
                  type="button"
                  key={`g:${g.artifactId ?? g.path ?? g.name}`}
                  className="ofp-tile"
                  aria-current={selection?.kind === "item" && (selection.item.artifactId ?? selection.item.name) === (g.artifactId ?? g.name)}
                  onClick={() => { setSelection({ kind: "item", item: g }); setSaved(null); centerFileView.open(); }}
                >
                  <span className="ofp-tile__art">
                    {previewKind(g.mimeType, g.name) === "image" && g.previewUrl
                      ? <img src={apiUrl(g.previewUrl)} alt="" loading="lazy" />
                      : <span className="ofp-tile__ext">{typeLabel(g.name, g.mimeType)}</span>}
                  </span>
                  <span className="ofp-tile__name" title={g.name}>{g.name}</span>
                  <span className="ofp-tile__meta">{formatBytes(g.bytes) || typeLabel(g.name, g.mimeType)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {center.open && center.host && selection && createPortal(
        <div className={`ofp ofp--${preview?.cloudCopy ? "cloud" : location} ofp-center`}>
          <section className="ofp-preview" aria-label="File" data-testid="workbench-file-preview">
            {selection && (
              <>
                <div className="ofp-preview__head">
                  <button type="button" className="ofp-btn ofp-back" onClick={leaveCenter} title="Back to the conversation">← Back to chat</button>
                  <span className="ofp-preview__name">
                    <b>{selName}</b>
                    <span title={previewPath(selection, location, projectRoot)}>{previewPath(selection, location, projectRoot)}</span>
                  </span>
                  <span className="ofp-actions">
                    {editing && (
                      <>
                        <button type="button" className="ofp-btn ofp-btn--primary" disabled={!dirty || saving} onClick={() => void saveEdits()} title="Save to your computer (Ctrl+S)">
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          className="ofp-btn"
                          disabled={saving}
                          onClick={() => { if (!dirty || window.confirm("Discard your changes?")) setEditing(null); }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {!editing && selection.kind === "project" && location === "local" && !preview?.cloudCopy && (
                      <>
                        {canEdit && (
                          <button type="button" className="ofp-btn ofp-btn--primary" onClick={() => void startEditing()}>Edit</button>
                        )}
                        <button type="button" className="ofp-btn" disabled={Boolean(preview?.error)} onClick={() => onOpenFile(selection.path)}>Open in Code</button>
                        <button
                          type="button"
                          className="ofp-btn"
                          disabled={Boolean(preview?.error)}
                          onClick={async () => {
                            setSaved(null);
                            try {
                              const ok = await window.orvyn?.project?.showInFolder?.(selection.path);
                              if (ok === undefined) setSaved({ error: "Show in folder needs the latest ORVYN desktop app." });
                              else if (!ok) setSaved({ error: "Could not open the folder." });
                            } catch (err) {
                              setSaved({ error: userFacingFileError(err) });
                            }
                          }}
                        >
                          Show in folder
                        </button>
                      </>
                    )}
                    {(location !== "local" || isGenerated || preview?.cloudCopy) && (
                      <button type="button" className="ofp-btn ofp-btn--primary" onClick={() => void downloadToComputer()}>Download to my computer</button>
                    )}
                    {isGenerated && onPreviewArtifact && (
                      <button type="button" className="ofp-btn" onClick={() => onPreviewArtifact(selection.item.name, selection.item.artifactId || preview?.artifactId)}>Open</button>
                    )}
                    {selectedChange && onOpenChanges && (
                      <button type="button" className="ofp-btn" onClick={() => onOpenChanges(originalPath.get(selectedChange.path) ?? selectedChange.path)}>Changes</button>
                    )}
                  </span>
                </div>
                {preview?.cloudCopy && (
                  <p className="ofp-cloudcopy">This file is not on your computer. ORION wrote it in <b>ORVYN Cloud</b>. Download it to keep a copy.</p>
                )}
                {saved && (
                  <p className={`ofp-saved${saved.error ? " is-error" : ""}`}>
                    {saved.error ? saved.error : saved.info ? saved.info : <>Saved to <code>{saved.path}</code>{window.orvyn?.files?.showSaved && saved.path && (
                      <button type="button" className="ofp-link" onClick={() => void window.orvyn.files!.showSaved(saved.path!)}>Show in folder</button>
                    )}</>}
                  </p>
                )}
                <div className="ofp-preview__body">
                  {preview == null ? (
                    <span className="ofp-muted">Loading…</span>
                  ) : preview.error ? (
                    <div className="ofp-preview__empty"><b>{preview.error}</b>{preview.note && <span>{preview.note}</span>}</div>
                  ) : preview.url && previewKind(selection.kind === "item" ? selection.item.mimeType : null, selName) === "pdf" ? (
                    <iframe title={selName} src={preview.url} className="ofp-pdf" />
                  ) : preview.url ? (
                    <img src={preview.url} alt={selName} className="ofp-img" />
                  ) : (
                    // One colored code view for reading and editing, same
                    // colors as the Code view. Read-only until Edit.
                    <div className="ofp-edit">
                      <Editor
                        height="100%"
                        theme="orvyn-dark"
                        path={`orvyn-files/${selection.kind === "project" ? selection.path : selName}`}
                        language={guessLanguage(selName)}
                        value={editing ? editing.text : preview.text ?? ""}
                        onChange={(v) => setEditing((e) => (e ? { ...e, text: v ?? "" } : e))}
                        onMount={(ed, monaco) => {
                          codeEditorRef.current = ed;
                          ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
                        }}
                        options={{
                          readOnly: !editing,
                          domReadOnly: !editing,
                          fontSize: 13,
                          fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
                          minimap: { enabled: false },
                          padding: { top: 8 },
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          wordWrap: "off",
                          renderLineHighlight: editing ? "line" : "none",
                          bracketPairColorization: { enabled: true },
                        }}
                      />
                    </div>
                  )}
                </div>
                <p className="ofp-foot"><i />{previewFooter(preview?.cloudCopy ? "cloud" : footerLoc, {
                  type: typeLabel(selName, selection.kind === "item" ? selection.item.mimeType : null),
                  bytes: preview?.bytes ?? (selection.kind === "project" ? selection.bytes : selection.item.bytes),
                  changed: selectedChange,
                })}</p>
              </>
            )}
          </section>
        </div>,
        center.host,
      )}
    </div>
  );
}

function previewPath(sel: Selection, loc: FilesLocation, projectRoot: string | null): string {
  if (sel.kind === "item") return sel.item.reference || sel.item.path || sel.item.name;
  if (loc === "local" && projectRoot) {
    const sep = projectRoot.includes("\\") ? "\\" : "/";
    return `${projectRoot.replace(/[\\/]+$/, "")}${sep}${sel.path.replace(/\//g, sep)}`;
  }
  return `cloud://${sel.path}`;
}

function withChildren(nodes: TreeNode[], cache: Record<string, TreeNode[]>): TreeNode[] {
  return nodes.map((n) => (n.dir ? { ...n, children: cache[n.path] ? withChildren(cache[n.path], cache) : [] } : n));
}

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.dir ? countFiles(n.children ?? []) : 1), 0);
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
