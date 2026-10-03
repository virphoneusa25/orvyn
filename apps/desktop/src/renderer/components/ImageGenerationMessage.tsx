import React, { useEffect, useRef, useState } from "react";
import { decodeImageSource, imageGenerationPresentation, imageGenerationView, retryImageGeneration, type ImageGenerationJob } from "../../../../../packages/ai-core/src/imageGeneration";
import { apiUrl, authHeaders } from "../connection";
import { openArtifactInContext } from "../contextOpen";
import { OrionPlasmaOrb } from "./OrionPlasmaOrb";
import "./ImageGenerationMessage.css";

export function ImageGenerationMessage({ job, onRetry, onReady, onFailed }: {
  job: ImageGenerationJob;
  onRetry?: (request: ReturnType<typeof retryImageGeneration>) => void;
  onReady?: () => void;
  onFailed?: (message: string) => void;
}) {
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
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setSrc(null);
    setLoadError(null);
    void fetch(apiUrl(`/artifacts/${encodeURIComponent(asset.artifactId)}/preview`), { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Image preview returned HTTP ${response.status}.`);
        objectUrl = URL.createObjectURL(await response.blob());
        return decodeImageSource(objectUrl);
      })
      .then(() => {
        if (controller.signal.aborted || !objectUrl) return;
        setSrc(objectUrl);
        callbacks.current.onReady?.();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "The generated image could not be loaded.";
        setLoadError(message);
        callbacks.current.onFailed?.(message);
      });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset?.artifactId, canLoad]);

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
