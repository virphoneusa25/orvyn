// apps/backend/src/images/ImageService.ts
import { promises as fs } from "fs";
import * as path from "path";
import { ModelService } from "../services/ModelService";
import type { ArtifactService } from "../artifacts/ArtifactService";
import { sanitizeArtifactName } from "../artifacts/ArtifactService";

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
}

export interface GeneratedImage {
  relativePath?: string;
  path?: string;
  filename?: string;
  dataUrl?: string;
  url?: string;
  revisedPrompt?: string;
  artifactId?: string;
}

function safeProjectDir(projectRoot: string): string {
  const resolved = path.resolve(projectRoot, ".orvyn", "generated");
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root)) throw new Error("Refused to write outside the project");
  return resolved;
}

function slugName(prompt: string, index: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "image";
  return `${slug}${index > 1 ? `-${index}` : ""}.png`;
}

export class ImageService {
  constructor(
    private modelService: ModelService,
    private artifacts?: ArtifactService
  ) {}

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
      const filename = req.filename
        ? sanitizeArtifactName(req.filename.endsWith(".png") ? req.filename : `${req.filename}.png`)
        : slugName(req.prompt, images.length + 1);
      const out: GeneratedImage = { url: item.url, revisedPrompt: item.revisedPrompt, filename };
      if (b64) {
        const bytes = Buffer.from(b64, "base64");
        out.dataUrl = `data:image/png;base64,${b64}`;
        if (this.artifacts) {
          const rec = await this.artifacts.create({
            name: filename,
            kind: "generated",
            bytes,
            mediaType: "image/png",
            projectRoot: req.projectRoot ?? null,
            runId: req.runId ?? null,
          });
          out.artifactId = rec.id;
          out.relativePath = rec.path;
          out.path = rec.path;
        } else if (req.projectRoot) {
          const dir = safeProjectDir(req.projectRoot);
          await fs.mkdir(dir, { recursive: true });
          const file = filename;
          await fs.writeFile(path.join(dir, file), bytes);
          out.relativePath = `.orvyn/generated/${file}`;
          out.path = out.relativePath;
        }
      }
      images.push(out);
    }
    if (images.length === 0) throw new Error("The image model returned no images");
    return { model: provider.config.id, images };
  }
}
