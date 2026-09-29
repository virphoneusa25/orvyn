import { downloadArtifact } from "../lib/api";
import { ago, bytes } from "../lib/format";
import type { Artifact } from "../lib/useApi";
import { FileVisual } from "./FileVisual";
import { Icon } from "./Icons";
import { usePreview } from "./Preview";

/** A file in a list: real thumbnail for images, typed icon otherwise, and Preview / Download. */
export function FileRow({ a }: { a: Artifact }) {
  const preview = usePreview();
  return (
    <div className="list__row" style={{ cursor: "default" }} data-testid="file-row">
      <FileVisual artifactId={a.artifactId} name={a.name} mimeType={a.mimeType} size={30} />
      <div className="list__main">
        <b title={a.name}>{a.name}</b>
        <span className="sub">{bytes(a.size)} · {ago(a.createdAt)}</span>
      </div>
      <button className="btn btn--sm" onClick={() => preview(a)} aria-label={`Preview ${a.name}`}><Icon.eye size={14} /> Preview</button>
      <button className="btn btn--sm" onClick={() => void downloadArtifact(a.artifactId, a.name)} aria-label={`Download ${a.name}`}><Icon.download size={14} /></button>
    </div>
  );
}
