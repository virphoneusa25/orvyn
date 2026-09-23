// apps/backend/src/images/ImageService.ts
import { ModelService } from "../services/ModelService";
import type { ArtifactService } from "../artifacts/ArtifactService";
import { sanitizeArtifactName } from "../artifacts/ArtifactService";
import { validateBytes } from "../artifacts/bytes";

export interface GenerateImageRequest {
  prompt: string;
  size?: string;
  n?: number;
  /** "high" | "medium" | "low" — defaults to high; unsupported servers fall back. */
  quality?: string;
  projectRoot?: string;
  modelId?: string;
  filename?: string;
  runId?: string;
  chatId?: string;
}

export interface GeneratedImage {
  filename: string;
  artifactId: string;
  mimeType: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  previewUrl?: string;
  revisedPrompt?: string;
}

function slugName(prompt: string, index: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "image";
  return `${slug}${index > 1 ? `-${index}` : ""}.png`;
}

async function bytesFromProviderItem(item: { b64?: string; url?: string }): Promise<Buffer> {
  if (item.b64) return Buffer.from(item.b64, "base64");
  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Image provider URL returned HTTP ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("Image provider URL returned zero bytes.");
    return buf;
  }
  throw new Error("Image provider returned neither image bytes nor a downloadable URL.");
}

export class ImageService {
  constructor(
    private modelService: ModelService,
    private artifacts: ArtifactService
  ) {}

  async generate(req: GenerateImageRequest): Promise<{ model: string; images: GeneratedImage[] }> {
    if (!req.prompt?.trim()) throw new Error("Prompt is required");
    if (!this.artifacts) throw new Error("Artifact storage is not configured. Image generation cannot succeed without persistence.");
    const provider = req.modelId
      ? this.modelService.registry.get(req.modelId)
      : this.modelService.router.resolve("image");
    if (!provider) throw new Error(`Unknown image model "${req.modelId}"`);
    if (!provider.generateImage) {
      throw new Error(`Model "${provider.config.id}" does not support image generation`);
    }

    const raw = await provider.generateImage({
      prompt: req.prompt.trim(),
      size: req.size,
      n: Math.min(Math.max(req.n ?? 1, 1), 4),
      quality: req.quality ?? "high",
    });

    const images: GeneratedImage[] = [];
    for (const item of raw) {
      const bytes = await bytesFromProviderItem(item);
      const filename = req.filename
        ? sanitizeArtifactName(req.filename.endsWith(".png") ? req.filename : `${req.filename}.png`)
        : slugName(req.prompt, images.length + 1);
      validateBytes(filename, "image/png", bytes);
      const rec = await this.artifacts.persistArtifact({
        name: filename,
        kind: "generated",
        bytes,
        mimeType: "image/png",
        projectRoot: req.projectRoot ?? null,
        runId: req.runId ?? null,
        chatId: req.chatId ?? null,
        sourceTool: "generate_image",
      });
      if (!rec.artifactId) throw new Error("Image bytes were produced but artifact persistence returned no artifactId.");
      const pub = this.artifacts.toToolResult(rec);
      images.push({
        filename: rec.name,
        artifactId: rec.artifactId,
        mimeType: rec.mimeType,
        size: rec.size,
        sha256: rec.sha256,
        downloadUrl: pub.downloadUrl ?? `/artifacts/${rec.artifactId}/download`,
        previewUrl: pub.previewUrl,
        revisedPrompt: item.revisedPrompt,
      });
    }
    if (images.length === 0) throw new Error("The image model returned no images");
    if (images.some((img) => !img.artifactId)) throw new Error("Image generation produced no persisted artifact.");
    return { model: provider.config.id, images };
  }
}
