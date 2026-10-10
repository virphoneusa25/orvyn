import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, apiUrl, blobUrl, downloadArtifact, imageLink } from "../lib/api";
import { fileKind, previewMode } from "../lib/fileKinds";
import { FileIcon } from "./FileVisual";
import { Icon } from "./Icons";

// The right-hand preview pane. Rendering is local: it fetches the stored file
// and shows it — it never calls a model and never spends credits. HTML runs in
// a sandboxed frame with no access to the portal.

export interface PreviewTarget { artifactId: string; name: string; mimeType?: string }
const Ctx = createContext<(t: PreviewTarget) => void>(() => undefined);
export const usePreview = () => useContext(Ctx);

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const open = useCallback((t: PreviewTarget) => setTarget(t), []);
  const close = useCallback(() => setTarget(null), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {target ? <PreviewPane key={target.artifactId} target={target} onClose={close} /> : null}
    </Ctx.Provider>
  );
}

function PreviewPane({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const kind = fileKind(target.name, target.mimeType);
  const mode = previewMode(kind);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viaBlob, setViaBlob] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let revoke: string | null = null;
    let alive = true;
    setUrl(null); setText(null); setError(null);
    (async () => {
      try {
        if (mode === "text") {
          const d = await api<{ content?: string }>(`/artifacts/${encodeURIComponent(target.artifactId)}`);
          if (alive) setText(d.content ?? "");
        } else if (mode === "html" || mode === "pdf") {
          // A real (sandboxed) URL: a blob frame would inherit the portal's CSP and its scripts could not run.
          const r = await api<{ url: string }>(`/artifacts/${encodeURIComponent(target.artifactId)}/preview-link`, { method: "POST", body: {} });
          if (alive) setUrl(apiUrl(r.url));
        } else if (mode === "image" && !viaBlob) {
          // A direct link: the browser streams and decodes the image itself.
          const link = await imageLink(target.artifactId);
          if (alive) setUrl(link);
        } else if (mode) {
          const b = await blobUrl(`/artifacts/${encodeURIComponent(target.artifactId)}/preview`);
          revoke = b.url;
          if (alive) setUrl(b.url);
        }
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { alive = false; if (revoke) URL.revokeObjectURL(revoke); window.removeEventListener("keydown", onKey); };
  }, [target.artifactId, mode, onClose, viaBlob, attempt]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="preview" role="dialog" aria-label={`Preview ${target.name}`} data-testid="preview-pane">
        <div className="preview__head">
          <FileIcon name={target.name} mimeType={target.mimeType} size={24} />
          <b title={target.name}>{target.name}</b>
          <button className="btn btn--sm" onClick={() => void downloadArtifact(target.artifactId, target.name)}><Icon.download size={16} /> Download</button>
          <button className="btn btn--sm btn--ghost" aria-label="Close preview" onClick={onClose}><Icon.x size={18} /></button>
        </div>
        <div className="preview__body">
          {error ? <div className="empty"><h3>Couldn't open this file</h3>{error}<div><button className="btn" onClick={() => { setViaBlob(true); setAttempt((n) => n + 1); }}>Try again</button></div></div>
            : !mode ? <div className="empty"><FileIcon name={target.name} mimeType={target.mimeType} size={56} /><h3>No preview for this type</h3>Download it to open it on your computer.</div>
            : mode === "text" ? (text === null ? <div className="empty">Loading…</div> : <pre data-testid="preview-text">{text}</pre>)
            : !url ? <div className="empty">Loading…</div>
            : mode === "image" ? <img src={url} alt={target.name} data-testid="preview-image" onError={() => { if (!viaBlob) setViaBlob(true); else setError("This image couldn't be shown. Download it to open it."); }} />
            : mode === "html" ? <iframe title={target.name} src={url} sandbox="allow-scripts" data-testid="preview-html" />
            : mode === "pdf" ? <iframe title={target.name} src={url} data-testid="preview-pdf" />
            : mode === "video" ? <video src={url} controls style={{ width: "100%" }} />
            : <audio src={url} controls style={{ width: "100%", marginTop: 20 }} />}
        </div>
      </aside>
    </>
  );
}
