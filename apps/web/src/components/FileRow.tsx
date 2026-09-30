import { downloadArtifact } from "../lib/api";
import { ago, bytes } from "../lib/format";
import type { Artifact } from "../lib/useApi";
import { FileVisual } from "./FileVisual";
import { Icon } from "./Icons";
import { usePreview } from "./Preview";

/** A file in a list: real thumbnail for images, typed icon otherwise; click to preview. */
export function FileRow({ a, onMenu }: { a: Artifact; onMenu?: React.ReactNode }) {
  const preview = usePreview();
  return (
    <div className="list__row" data-testid="file-row" onClick={() => preview(a)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") preview(a); }}>
      <FileVisual artifactId={a.artifactId} name={a.name} mimeType={a.mimeType} size={30} />
      <div className="list__main">
        <b title={a.name}>{a.name}</b>
        <span className="sub">{bytes(a.size)} · {a.kind === "generated" ? "Made by ORVYN" : "Uploaded"} · {ago(a.createdAt)}</span>
      </div>
      <button className="kebab" onClick={(e) => { e.stopPropagation(); preview(a); }} aria-label={`Preview ${a.name}`} title="Preview"><Icon.eye size={15} /></button>
      <button className="kebab" onClick={(e) => { e.stopPropagation(); void downloadArtifact(a.artifactId, a.name); }} aria-label={`Download ${a.name}`} title="Download"><Icon.download size={15} /></button>
      {onMenu}
    </div>
  );
}
