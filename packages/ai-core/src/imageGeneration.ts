export type ImageGenerationStatus = "queued" | "generating" | "provider-completed" | "completed" | "failed";

export interface GeneratedImageAsset {
  artifactId: string;
  name: string;
  mimeType: string;
}

export interface ImageGenerationJob {
  id: string;
  prompt: string;
  status: ImageGenerationStatus;
  assets?: GeneratedImageAsset[];
  error?: string;
  modelId?: string;
  userMessageId?: string;
}

export type ImageGenerationView = "queued" | "generating" | "finalizing" | "completed" | "failed" | "asset-error";

export interface ImageGenerationPresentation {
  view: ImageGenerationView;
  message: string;
  statusTitle?: string;
  showActions: boolean;
  showRetry: boolean;
}

/** Presentation is gated on the decoded asset, not the provider's response. */
export function imageGenerationView(job: ImageGenerationJob): ImageGenerationView {
  if (job.status === "failed") return "failed";
  if (job.status === "queued") return "queued";
  if (job.status === "generating") return "generating";
  if (!job.assets?.length || job.assets.some((asset) => !asset.artifactId || !asset.name || !asset.mimeType.startsWith("image/"))) return "failed";
  return job.status === "completed" ? "completed" : "finalizing";
}

export function imageGenerationPresentation(job: ImageGenerationJob): ImageGenerationPresentation {
  const view = imageGenerationView(job);
  if (view === "queued") return { view, message: "Absolutely — I'm preparing that image for you.", statusTitle: "Preparing image…", showActions: false, showRetry: false };
  if (view === "generating") return { view, message: "Absolutely — I'm creating that image for you.", statusTitle: "Creating image…", showActions: false, showRetry: false };
  if (view === "finalizing") return { view, message: "Finalizing your image…", statusTitle: "Finalizing image…", showActions: false, showRetry: false };
  if (view === "completed") return { view, message: "Here's your image.", showActions: true, showRetry: false };
  return { view, message: "I couldn't finish generating that image.", showActions: false, showRetry: true };
}

/** The provider succeeded; only fetching the saved media failed. */
export function imageAssetFailurePresentation(error: string): ImageGenerationPresentation {
  return {
    view: "asset-error",
    message: "Your image was generated, but I couldn't load it.",
    statusTitle: error || "The saved image could not be loaded.",
    showActions: false,
    showRetry: true,
  };
}

export function retryImageGeneration(job: ImageGenerationJob): Pick<ImageGenerationJob, "prompt" | "modelId"> {
  return { prompt: job.prompt, ...(job.modelId ? { modelId: job.modelId } : {}) };
}

/** Frontend completion is legal only after decodeImageSource resolved. */
export function markImageGenerationReady(job: ImageGenerationJob): ImageGenerationJob {
  if (!job.assets?.length || job.assets.some((asset) => !asset.artifactId || !asset.mimeType.startsWith("image/"))) {
    return { ...job, status: "failed", error: "The image result is unavailable." };
  }
  return { ...job, status: "completed", error: undefined };
}

export function markImageGenerationFailed(job: ImageGenerationJob, error: string): ImageGenerationJob {
  return { ...job, status: "failed", error: error || "The image could not be loaded." };
}

export interface ImageElementLike {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode?: () => Promise<void>;
}

/** Resolve only after load and decode both confirm that the image is displayable. */
export function decodeImageSource(source: string, createImage: () => ImageElementLike = () => new Image() as unknown as ImageElementLike, timeoutMs = 30_000): Promise<ImageElementLike> {
  return new Promise((resolve, reject) => {
    const image = createImage();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); image.onload = null; image.onerror = null; };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The generated image could not be loaded or decoded."));
    };
    timer = setTimeout(() => fail(), timeoutMs);
    image.onload = () => {
      if (settled) return;
      const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decoded.then(() => {
        if (settled) return;
        if (!(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return fail();
        settled = true;
        cleanup();
        resolve(image);
      }, fail);
    };
    image.onerror = fail;
    image.src = source;
  });
}
