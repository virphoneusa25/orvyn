// apps/backend/src/images/ImageService.ts
import { promises as fs } from "fs";
import * as path from "path";
import { ModelService } from "../services/ModelService";

export interface GenerateImageRequest {
  prompt: string;
  size?: string;
  n?: number;
  /** "high" | "medium" | "low" — defaults to high; unsupported servers fall back. */
  quality?: string;
  projectRoot?: string;
  modelId?: string;
}

export interface GeneratedImage {
  relativePath?: string;
  dataUrl?: string;
  url?: string;
  revisedPrompt?: string;
}

function safeProjectDir(projectRoot: string): string {
  const resolved = path.resolve(projectRoot, ".orvyn", "generated");
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root)) throw new Error("Refused to write outside the project");
  return resolved;
}

export class ImageService {
  constructor(private modelService: ModelService) {}

  async generate(req: GenerateImageRequest): Promise<{ model: string; images: GeneratedImage[] }> {
    if (!req.prompt?.trim()) throw new Error("Prompt is required");
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
      let b64 = item.b64;
      if (!b64 && item.url) {
        try {
          const res = await fetch(item.url);
          if (res.ok) b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        } catch {
          // Keep the remote URL if we cannot download it.
        }
      }
      const out: GeneratedImage = { url: item.url, revisedPrompt: item.revisedPrompt };
      if (b64) {
        out.dataUrl = `data:image/png;base64,${b64}`;
        if (req.projectRoot) {
          const dir = safeProjectDir(req.projectRoot);
          await fs.mkdir(dir, { recursive: true });
          const file = `img-${Date.now()}-${images.length + 1}.png`;
          await fs.writeFile(path.join(dir, file), Buffer.from(b64, "base64"));
          out.relativePath = `.orvyn/generated/${file}`;
        }
      }
      images.push(out);
    }
    if (images.length === 0) throw new Error("The image model returned no images");
    return { model: provider.config.id, images };
  }
}
