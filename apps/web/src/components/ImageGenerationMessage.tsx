import { useEffect, useRef, useState } from "react";
import { decodeImageSource, imageGenerationPresentation, imageGenerationView, retryImageGeneration, type ImageGenerationJob } from "../../../../packages/ai-core/src/imageGeneration";
import { blobUrl, downloadArtifact, imageLink } from "../lib/api";
import { usePreview } from "./Preview";
import { Orb } from "./Orb";
import { Icon } from "./Icons";
import "./ImageGenerationMessage.css";

export function ImageGenerationMessage({ job, onRetry, onReady, onFailed }: {
  job: ImageGenerationJob;
  onRetry?: (request: ReturnType<typeof retryImageGeneration>) => void;
  onReady?: () => void;
  onFailed?: (message: string) => void;
}) {
  const preview = usePreview();
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const callbacks = useRef({ onReady, onFailed });
  callbacks.current = { onReady, onFailed };
  const asset = job.assets?.[0];
  const canLoad = Boolean(asset && ["provider-completed", "completed"].includes(job.status));
  const lifecycleView = imageGenerationView(job);
  const view = loadError ? "failed" : lifecycleView === "completed" && !src ? "finalizing" : lifecycleView;

  useEffect(() => {
    if (!asset || !canLoad) return;
    let alive = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setLoadError(null);
    const setReady = (url: string) => decodeImageSource(url).then(() => {
      if (!alive) return;
      setSrc(url);
      callbacks.current.onReady?.();
    });
    void (async () => {
      try {
        const directUrl = await imageLink(asset.artifactId);
        try { await setReady(directUrl); return; } catch { /* stale direct link: retry authenticated blob */ }
      } catch { /* get a fresh authenticated blob URL below */ }
      if (!alive) return;
      const blob = await blobUrl(`/artifacts/${encodeURIComponent(asset.artifactId)}/preview`);
      objectUrl = blob.url;
      await setReady(objectUrl);
    })().catch((error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : "The generated image could not be loaded.";
        setLoadError(message);
        callbacks.current.onFailed?.(message);
    });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset?.artifactId, canLoad]);

  if (view === "completed" && src && asset) return <div className="image-generation" data-testid="image-generation-completed">
    <p className="image-generation__message">Here's your image.</p>
    <div className="image-generation__result">
      <img src={src} alt={asset.name} className="image-generation__image" />
      <div className="image-generation__actions">
        <button type="button" className="btn btn--sm" onClick={() => preview({ artifactId: asset.artifactId, name: asset.name, mimeType: asset.mimeType })}><Icon.eye size={14} /> Open</button>
        <button type="button" className="btn btn--sm" onClick={() => void downloadArtifact(asset.artifactId, asset.name)}><Icon.download size={14} /> Download</button>
      </div>
    </div>
  </div>;

  if (view === "failed") return <div className="image-generation" data-testid="image-generation-failed">
    <p className="image-generation__message">I couldn't finish generating that image.</p>
    <div className="image-generation__failure" role="alert">
      {loadError || job.error || "The image generation request failed."}
      {onRetry ? <button type="button" className="btn btn--sm" onClick={() => onRetry(retryImageGeneration(job))}><Icon.retry size={14} /> Retry</button> : null}
    </div>
  </div>;

  const copy = imageGenerationPresentation(view === "finalizing" ? { ...job, status: "provider-completed" } : job);
  const title = view === "finalizing" ? copy.statusTitle : view === "queued" ? copy.statusTitle : "Creating image…";
  return <div className="image-generation" data-testid={`image-generation-${view}`}>
    <p className="image-generation__message">{copy.message}</p>
    <div className="image-generation__loading" role="status" aria-live="polite">
      <span className="image-generation__orb"><Orb /></span>
      <span className="image-generation__copy"><strong>{title}</strong><small>This may take a moment.</small></span>
    </div>
  </div>;
}
