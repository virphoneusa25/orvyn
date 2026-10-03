import React, { useEffect, useRef, useState } from "react";
import { decodeImageSource, imageAssetFailurePresentation, imageGenerationPresentation, imageGenerationView, retryImageGeneration, type ImageGenerationJob } from "../../../../../packages/ai-core/src/imageGeneration";
import { apiUrl, authHeaders } from "../connection";
import { openArtifactInContext } from "../contextOpen";
import { OrionPlasmaOrb } from "./OrionPlasmaOrb";
import "./ImageGenerationMessage.css";

export function ImageGenerationMessage({ job, onRetry, onReady }: {
  job: ImageGenerationJob;
  onRetry?: (request: ReturnType<typeof retryImageGeneration>) => void;
  onReady?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const callbacks = useRef({ onReady });
  callbacks.current = { onReady };
  const asset = job.assets?.[0];
  const canLoad = Boolean(asset && ["provider-completed", "completed"].includes(job.status));
  const lifecycleView = imageGenerationView(job);
  const view = job.status === "failed" ? "failed" : loadError ? "asset-error" : lifecycleView === "completed" && !src ? "finalizing" : lifecycleView;

  useEffect(() => {
    if (!asset || !canLoad) return;
    setSrc(null);
    setLoadError(null);
    let alive = true;
    void (async () => {
      const response = await fetch(apiUrl(`/artifacts/${encodeURIComponent(asset.artifactId)}/preview-link`), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`Image preview link returned HTTP ${response.status}.`);
      const payload = await response.json() as { url?: string };
      if (!payload.url) throw new Error("The image preview link was missing.");
      // Let the browser stream the image directly instead of buffering the whole file as a Blob.
      const url = new URL(payload.url, apiUrl("")).toString();
      await decodeImageSource(url);
      if (!alive) return;
      setSrc(url);
      callbacks.current.onReady?.();
    })().catch((error: unknown) => {
      if (alive) setLoadError(error instanceof Error ? error.message : "The generated image could not be loaded.");
    });
    return () => { alive = false; };
  }, [asset?.artifactId, canLoad, loadAttempt]);

  const download = async () => {
    if (view !== "completed" || !asset) return;
    const response = await fetch(apiUrl(`/artifacts/${encodeURIComponent(asset.artifactId)}/download`), { headers: authHeaders() });
    if (!response.ok) throw new Error("The generated image could not be downloaded.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = asset.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (view === "completed" && src && asset) {
    return <div className="image-generation" data-testid="image-generation-completed">
      <p className="image-generation__message">Here's your image.</p>
      <div className="image-generation__result"><img src={src} alt={asset.name} className="image-generation__image" />
        <div className="image-generation__actions">
          <button type="button" onClick={() => openArtifactInContext({ tab: "preview", artifactId: asset.artifactId, fileName: asset.name })}>Open</button>
          <button type="button" onClick={() => void download()}>Download</button>
        </div>
      </div>
    </div>;
  }

  if (view === "failed") return <div className="image-generation" data-testid="image-generation-failed">
    <p className="image-generation__message">I couldn't finish generating that image.</p>
    <div className="image-generation__failure" role="alert">
      {loadError || job.error || "The image generation request failed."}
      {onRetry && <button type="button" onClick={() => onRetry(retryImageGeneration(job))}>Retry</button>}
    </div>
  </div>;

  if (view === "asset-error" && loadError) {
    const copy = imageAssetFailurePresentation(loadError);
    return <div className="image-generation" data-testid="image-generation-asset-error">
      <p className="image-generation__message">{copy.message}</p>
      <div className="image-generation__failure" role="alert">
        {copy.statusTitle}
        <button type="button" onClick={() => { setLoadError(null); setSrc(null); setLoadAttempt((attempt) => attempt + 1); }}>Try loading image again</button>
        {onRetry && <button type="button" onClick={() => onRetry(retryImageGeneration(job))}>Generate a new image</button>}
      </div>
    </div>;
  }

  const copy = imageGenerationPresentation(view === "finalizing" ? { ...job, status: "provider-completed" } : job);
  const title = view === "finalizing" ? copy.statusTitle : view === "queued" ? copy.statusTitle : "Creating image…";
  return <div className="image-generation" data-testid={`image-generation-${view}`}>
    <p className="image-generation__message">{copy.message}</p>
    <div className="image-generation__loading" role="status" aria-live="polite">
      <OrionPlasmaOrb motion="tool" />
      <span><strong>{title}</strong><small>This may take a moment.</small></span>
    </div>
  </div>;
}
