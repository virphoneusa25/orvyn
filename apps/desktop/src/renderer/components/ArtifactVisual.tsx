// apps/desktop/src/renderer/components/ArtifactVisual.tsx
//
// THE one shared visual for generated files / project artifacts:
//   image asset → the REAL rendered thumbnail (never a file icon)
//   empty file  → muted treatment
//   code/doc    → the colorful brand FileTypeIcon (never a dark empty box)
// Decision logic lives in fileVisuals.ts (pure, tested); this component adds
// the authenticated fetch for real thumbnails. Chat cards and Files →
// Generated both render it — nothing else re-implements this.

import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { FileTypeIcon } from "./FileTypeIcon";
import { artifactVisualFor, visualLabelFor } from "../fileVisuals";

export function ArtifactVisualThumb({
  name,
  artifactId,
  mimeType,
  size = 0,
  iconSize = 40,
  previewUrl,
}: {
  name: string;
  artifactId?: string;
  mimeType?: string;
  /** Byte size; 0 marks an empty/failed artifact (muted treatment). */
  size?: number;
  /** Icon size inside the stable thumbnail box. */
  iconSize?: number;
  /** Optional authenticated preview endpoint (defaults to /files/read?id=). */
  previewUrl?: string;
}): React.ReactElement {
  const visual = artifactVisualFor(name, { mimeType, size });
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDataUrl(null);
    setFailed(false);
    if (visual.kind !== "thumbnail" || !artifactId) return;
    const url = previewUrl ? apiUrl(previewUrl) : apiUrl(`/files/read?id=${encodeURIComponent(artifactId)}`);
    fetch(url, { headers: authHeaders(), signal: controller.signal })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || typeof d?.dataUrl !== "string") throw new Error("no image");
        if (!controller.signal.aborted) setDataUrl(d.dataUrl);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [artifactId, visual.kind, previewUrl]);

  const opacity = visual.kind === "empty" ? 0.45 : 1;

  if (visual.kind === "thumbnail" && dataUrl && !failed) {
    return <img src={dataUrl} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  }
  // Icons (and images whose fetch failed → their file-type icon, never a
  // native broken-image glyph).
  return (
    <span
      title={visual.kind === "empty" ? "Empty file" : visual.kind === "icon" ? visual.label : visualLabelFor(name)}
      style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity }}
    >
      <FileTypeIcon path={name} size={iconSize} />
    </span>
  );
}
