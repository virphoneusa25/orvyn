import { useMemo, useRef, useState } from "react";
import { api, downloadArtifact } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { fileKind, type FileKind } from "../lib/fileKinds";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { useApi, type Artifact } from "../lib/useApi";
import { uploadFiles } from "../lib/upload";
import { FileIcon, Thumb } from "../components/FileVisual";
import { Icon } from "../components/Icons";
import { Modal } from "../components/Bits";
import { usePreview } from "../components/Preview";

const FILTERS: { id: string; label: string; kinds?: FileKind[]; source?: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images", kinds: ["image"] },
  { id: "docs", label: "Documents", kinds: ["pdf", "md", "txt", "doc", "xls", "ppt", "csv"] },
  { id: "code", label: "Code", kinds: ["html", "css", "js", "ts", "json", "code"] },
  { id: "generated", label: "Generated", source: "generated" },
  { id: "uploads", label: "Uploads", source: "upload" },
];

export function Files() {
  const { toast } = useStore();
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const { data, loading, reload } = useApi<{ artifacts: Artifact[] }>(q ? `/artifacts?q=${encodeURIComponent(q)}` : "/artifacts");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"new" | "name" | "size">("new");
  const [removing, setRemoving] = useState<Artifact | null>(null);
  const upload = useRef<HTMLInputElement | null>(null);
  const preview = usePreview();

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const list = (data?.artifacts ?? []).filter((a) => a.kind !== "run")
      .filter((a) => !f.kinds || f.kinds.includes(fileKind(a.name, a.mimeType)))
      .filter((a) => !f.source || a.kind === f.source);
    return list.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "size" ? b.size - a.size : b.createdAt - a.createdAt);
  }, [data, filter, sort]);

  return (
    <>
      <div className="spread">
        <div><h1 className="page-title">Files</h1><p className="page-sub">Everything you've uploaded or ORVYN has made. Previews open here and never use credits.</p></div>
        <button className="btn btn--primary" onClick={() => upload.current?.click()}><Icon.upload size={18} /> Upload</button>
      </div>
      <input ref={upload} type="file" multiple hidden data-testid="files-upload" onChange={async (e) => {
        const list = Array.from(e.target.files ?? []); e.target.value = "";
        if (!list.length) return;
        const r = await uploadFiles(list);
        toast(r.skipped.length ? `Uploaded ${r.ok}. Skipped: ${r.skipped.join(", ")}` : `Uploaded ${r.ok} file${r.ok === 1 ? "" : "s"}.`);
        reload();
      }} />
      <div className="files-bar">
        <div className="seg" role="tablist">
          {FILTERS.map((f) => <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "is-on" : ""} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <select className="input select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort" style={{ height: 38 }}>
          <option value="new">Newest</option><option value="name">Name</option><option value="size">Size</option>
        </select>
        {q ? <span className="tag tag--violet">Search: {q} <button className="linkbtn" onClick={() => navigate("/files")} aria-label="Clear search"><Icon.x size={12} /></button></span> : null}
      </div>
      {loading && !data ? <div className="empty">Loading…</div> : null}
      {!loading && !rows.length ? <div className="card empty"><h3>No files here yet</h3>Upload files, or ask ORVYN to make something in a chat.</div> : null}
      <div className="files-grid">
        {rows.map((a) => {
          const image = fileKind(a.name, a.mimeType) === "image";
          return (
            <div key={a.artifactId} className="card file-card" data-testid="file-card" data-kind={fileKind(a.name, a.mimeType)}>
              <button className="file-card__thumb" onClick={() => preview(a)} style={{ cursor: "pointer", padding: 0 }} aria-label={`Preview ${a.name}`}>
                {image ? <Thumb artifactId={a.artifactId} name={a.name} fallbackSize={54} /> : <FileIcon name={a.name} mimeType={a.mimeType} size={54} />}
              </button>
              <div className="file-card__name" title={a.name}>{a.name}</div>
              <div className="file-card__meta">{bytes(a.size)} · {a.kind === "generated" ? "Generated" : a.kind === "upload" ? "Uploaded" : "File"} · {ago(a.createdAt)}</div>
              <div className="file-card__actions">
                <button className="btn btn--sm" onClick={() => preview(a)} data-testid="file-preview"><Icon.eye size={14} /> Preview</button>
                <button className="btn btn--sm" onClick={() => void downloadArtifact(a.artifactId, a.name)} data-testid="file-download"><Icon.download size={14} /> Download</button>
                <button className="btn btn--sm btn--ghost" onClick={() => setRemoving(a)} aria-label={`Delete ${a.name}`}><Icon.trash size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
      {removing ? (
        <Modal title="Delete this file?" onClose={() => setRemoving(null)}>
          <p className="muted">“{removing.name}” is removed from your account for good.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn--danger" onClick={async () => { try { await api(`/artifacts/${removing.artifactId}`, { method: "DELETE" }); reload(); } catch (err: any) { toast(err.message); } setRemoving(null); }}>Delete</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
