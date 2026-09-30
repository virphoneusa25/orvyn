import { useMemo, useRef, useState } from "react";
import { api, downloadArtifact } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { fileKind, type FileKind } from "../lib/fileKinds";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { useSignal } from "../lib/events";
import { useApi, type Artifact, type Project } from "../lib/useApi";
import { FileIcon, FileVisual, Thumb } from "../components/FileVisual";
import { Icon } from "../components/Icons";
import { Empty, Modal, PageHead } from "../components/Bits";
import { ActionMenu } from "../components/Menu";
import { usePreview } from "../components/Preview";
import { useUploader } from "../components/Uploader";

const FILTERS: { id: string; label: string; kinds?: FileKind[]; source?: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images", kinds: ["image"] },
  { id: "docs", label: "Documents", kinds: ["pdf", "md", "txt", "doc", "xls", "ppt", "csv"] },
  { id: "code", label: "Code", kinds: ["html", "css", "js", "ts", "json", "code"] },
  { id: "generated", label: "Made by ORVYN", source: "generated" },
  { id: "uploads", label: "Uploads", source: "upload" },
];

export function Files() {
  const { toast } = useStore();
  const { query } = useLocation();
  const [q, setQ] = useState(query.get("q") ?? "");
  const { data, loading, reload } = useApi<{ artifacts: Artifact[] }>("/artifacts");
  const projects = useApi<{ projects: Project[] }>("/projects");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"new" | "name" | "size">("new");
  const [view, setView] = useState<"grid" | "list">(() => { try { return (localStorage.getItem("orvyn.filesView") as "grid" | "list") || "grid"; } catch { return "grid"; } });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Artifact[] | null>(null);
  const upload = useRef<HTMLInputElement | null>(null);
  const preview = usePreview();
  const uploader = useUploader({ onDone: reload });
  useSignal("files", reload);

  const setViewKeep = (v: "grid" | "list") => { setView(v); try { localStorage.setItem("orvyn.filesView", v); } catch { /* per-browser convenience only */ } };
  const projectName = (id?: string | null) => (id ? projects.data?.projects.find((p) => p.id === id)?.name : undefined);

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const needle = q.trim().toLowerCase();
    const list = (data?.artifacts ?? []).filter((a) => a.kind !== "run")
      .filter((a) => !needle || a.name.toLowerCase().includes(needle))
      .filter((a) => !f.kinds || f.kinds.includes(fileKind(a.name, a.mimeType)))
      .filter((a) => !f.source || a.kind === f.source);
    return list.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "size" ? b.size - a.size : b.createdAt - a.createdAt);
  }, [data, filter, sort, q]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selected = rows.filter((a) => sel.has(a.artifactId));
  const totalSize = (data?.artifacts ?? []).filter((a) => a.kind !== "run").reduce((s, a) => s + (a.size || 0), 0);

  const menu = (a: Artifact) => [
    { label: "Preview", icon: <Icon.eye size={15} />, onClick: () => preview(a) },
    { label: "Download", icon: <Icon.download size={15} />, onClick: () => void downloadArtifact(a.artifactId, a.name) },
    ...(a.projectId && projectName(a.projectId) ? [{ label: `Open ${projectName(a.projectId)}`, icon: <Icon.folder size={15} />, onClick: () => navigate(`/projects/${a.projectId}`) }] : []),
    ...(a.chatId ? [{ label: "Open its chat", icon: <Icon.chat size={15} />, onClick: () => navigate(`/chats/${a.chatId}`) }] : []),
    "sep" as const,
    { label: "Delete", icon: <Icon.trash size={15} />, onClick: () => setRemoving([a]), danger: true },
  ];

  return (
    <div className="page">
      <PageHead title="Files" sub={<>Everything you've uploaded or ORVYN has made{data ? ` · ${rows.length} file${rows.length === 1 ? "" : "s"} · ${bytes(totalSize)}` : ""}. Previews never use credits.</>}>
        <button className="btn btn--primary" onClick={() => upload.current?.click()}><Icon.upload size={17} /> Upload</button>
      </PageHead>
      <input ref={upload} type="file" multiple hidden data-testid="files-upload" onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; void uploader.start(list); }} />
      <div className="files-bar">
        <label className="search"><Icon.search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" aria-label="Search files" /></label>
        <div className="seg" role="tablist">
          {FILTERS.map((f) => <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "is-on" : ""} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <div style={{ flex: 1 }} />
        <select className="input select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort" style={{ height: 34 }}>
          <option value="new">Newest</option><option value="name">Name</option><option value="size">Size</option>
        </select>
        <div className="seg" aria-label="View">
          <button className={view === "grid" ? "is-on" : ""} onClick={() => setViewKeep("grid")} aria-label="Grid view" title="Grid"><Icon.grid size={15} /></button>
          <button className={view === "list" ? "is-on" : ""} onClick={() => setViewKeep("list")} aria-label="List view" title="List" data-testid="files-list-view"><Icon.listIcon size={15} /></button>
        </div>
      </div>
      {selected.length ? (
        <div className="bulkbar" data-testid="bulkbar">
          <b>{selected.length} selected</b>
          <button className="btn btn--sm" onClick={() => { selected.forEach((a, i) => window.setTimeout(() => void downloadArtifact(a.artifactId, a.name), i * 250)); }}><Icon.download size={14} /> Download</button>
          <button className="btn btn--sm btn--danger" onClick={() => setRemoving(selected)} data-testid="bulk-delete"><Icon.trash size={14} /> Delete</button>
          <button className="btn btn--sm btn--ghost" style={{ marginLeft: "auto" }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      ) : null}
      {loading && !data ? <div className="files-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="card skeleton" style={{ height: 196 }} />)}</div> : null}
      {data && !rows.length ? (
        <div className="card"><Empty icon={<Icon.file size={24} />} title={q || filter !== "all" ? "Nothing matches" : "No files yet"} action={!q && filter === "all" ? <button className="btn btn--primary" onClick={() => upload.current?.click()}><Icon.upload size={16} /> Upload files</button> : undefined}>
          {q || filter !== "all" ? "Try another search or filter." : "Drop files anywhere on this page, or ask ORVYN to make something in a chat."}
        </Empty></div>
      ) : null}
      {view === "grid" ? (
        <div className={`files-grid${selected.length ? " is-selecting" : ""}`}>
          {rows.map((a) => {
            const image = fileKind(a.name, a.mimeType) === "image";
            return (
              <div key={a.artifactId} className={`card file-card${sel.has(a.artifactId) ? " is-sel" : ""}`} data-testid="file-card" data-kind={fileKind(a.name, a.mimeType)}>
                <input type="checkbox" className="file-card__sel" checked={sel.has(a.artifactId)} onChange={() => toggle(a.artifactId)} aria-label={`Select ${a.name}`} />
                <button className="file-card__thumb" onClick={() => preview(a)} aria-label={`Preview ${a.name}`}>
                  {image ? <Thumb artifactId={a.artifactId} name={a.name} fallbackSize={54} /> : <FileIcon name={a.name} mimeType={a.mimeType} size={54} />}
                </button>
                <div className="file-card__info">
                  <div>
                    <div className="file-card__name" title={a.name}>{a.name}</div>
                    <div className="file-card__meta" title={`${bytes(a.size)} · ${a.kind === "generated" ? "Made by ORVYN" : a.kind === "upload" ? "Uploaded" : "File"} · ${ago(a.createdAt)}`}>{bytes(a.size)} · {ago(a.createdAt)}</div>
                  </div>
                  <ActionMenu label={`Actions for ${a.name}`} trigger={<Icon.more size={16} />} items={menu(a)} />
                </div>
                <div className="file-card__actions">
                  <button className="btn btn--sm" onClick={() => preview(a)} data-testid="file-preview"><Icon.eye size={14} /> Preview</button>
                  <button className="btn btn--sm" onClick={() => void downloadArtifact(a.artifactId, a.name)} data-testid="file-download"><Icon.download size={14} /> Download</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : rows.length ? (
        <div className="card file-list">
          <table className="table">
            <thead><tr><th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={selected.length === rows.length && rows.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.artifactId)) : new Set())} /></th><th>Name</th><th>Where</th><th>Size</th><th>Added</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.artifactId} data-testid="file-list-row">
                  <td><input type="checkbox" checked={sel.has(a.artifactId)} onChange={() => toggle(a.artifactId)} aria-label={`Select ${a.name}`} /></td>
                  <td><button className="file-list__name linkbtn" style={{ color: "inherit" }} onClick={() => preview(a)}><FileVisual artifactId={a.artifactId} name={a.name} mimeType={a.mimeType} size={26} /><b>{a.name}</b></button></td>
                  <td className="muted">{projectName(a.projectId) ?? (a.kind === "generated" ? "Made by ORVYN" : a.chatId ? "Chat" : "Uploads")}</td>
                  <td className="muted">{bytes(a.size)}</td>
                  <td className="muted">{ago(a.createdAt)}</td>
                  <td style={{ textAlign: "right" }}><ActionMenu label={`Actions for ${a.name}`} trigger={<Icon.more size={16} />} items={menu(a)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {uploader.ui}
      {removing ? (
        <Modal title={removing.length === 1 ? "Delete this file?" : `Delete ${removing.length} files?`} onClose={() => setRemoving(null)}>
          <p className="muted" style={{ marginTop: 0 }}>{removing.length === 1 ? `“${removing[0]!.name}” is` : "These files are"} removed from your account for good.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn--danger" data-testid="confirm-delete-files" onClick={async () => {
              let failed = 0;
              for (const a of removing) { try { await api(`/artifacts/${a.artifactId}`, { method: "DELETE" }); } catch { failed++; } }
              if (failed) toast(`${failed} file${failed === 1 ? "" : "s"} couldn't be deleted.`);
              setSel(new Set()); setRemoving(null); reload();
            }}>Delete</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
