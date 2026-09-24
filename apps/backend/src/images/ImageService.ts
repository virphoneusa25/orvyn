// apps/backend/src/images/ImageService.ts
import { promises as fs } from "fs";
import { ModelService } from "../services/ModelService";
import type { ArtifactService } from "../artifacts/ArtifactService";
import { sanitizeArtifactName } from "../artifacts/ArtifactService";
import { validateBytes } from "../artifacts/bytes";
import { selectImageModel } from "../models/selectModel";
import { FireworksKontextProvider } from "./fireworksKontext";

export interface GenerateImageRequest {
  prompt: string;
  size?: string;
  n?: number;
  /** "high" | "medium" | "low" — defaults to high; unsupported servers fall back. */
  quality?: string;
  projectRoot?: string;
  modelId?: string;
  editing?: boolean;
  /** Base64 or URL of the image being edited. */
  inputImage?: string;
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
  providerRequestId?: string;
  downloadUrl: string;
  previewUrl?: string;
  revisedPrompt?: string;
}

function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { mime: "image/png", ext: ".png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: ".webp" };
  return null;
}

function slugName(prompt: string, index: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "image";
  return `${slug}${index > 1 ? `-${index}` : ""}.png`;
}

function decodeBase64Payload(raw: string): Buffer {
  let payload = raw.trim();
  if (payload.startsWith("data:")) {
    const comma = payload.indexOf(",");
    if (comma < 0) throw new Error("Image provider data URL is missing payload.");
    payload = payload.slice(comma + 1);
  }
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length) throw new Error("Image provider returned empty base64.");
  return bytes;
}

async function bytesFromProviderItem(item: { b64?: string; url?: string; path?: string }): Promise<Buffer> {
  if (item.b64) return decodeBase64Payload(item.b64);
  if (item.url?.startsWith("data:")) return decodeBase64Payload(item.url);
  if (item.path || (item.url && !/^https?:\/\//i.test(item.url))) {
    const filePath = String(item.path ?? item.url ?? "").replace(/^file:\/\//, "");
    if (!filePath) throw new Error("Image provider path was empty.");
    const buf = await fs.readFile(filePath);
    if (!buf.length) throw new Error("Image provider temp path returned zero bytes.");
    return buf;
  }
  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Image provider URL returned HTTP ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("Image provider URL returned zero bytes.");
    return buf;
  }
  throw new Error("Image provider returned neither image bytes nor a downloadable URL. A text description is not an image.");
}

export class ImageService {
  constructor(
    private modelService: ModelService,
    private artifacts: ArtifactService
  ) {}

  async generate(req: GenerateImageRequest): Promise<{ model: string; images: GeneratedImage[] }> {
    if (!req.prompt?.trim()) throw new Error("Prompt is required");
    if (!this.artifacts) throw new Error("Artifact storage is not configured. Image generation cannot succeed without persistence.");
    const listed = typeof this.modelService.registry.list === "function" ? this.modelService.registry.list() : [];
    const imageModels = listed.filter((p) => p.config.capabilities.image);
    const imageChoice = selectImageModel({
      quality: req.quality,
      editing: req.editing,
      requestedModelId: req.modelId,
      availableIds: imageModels.map((p) => p.config.id),
      catalog: imageModels.map((p) => ({
        registryId: p.config.id,
        generation: true,
        editing: p.config.capabilities.imageEditing === true,
      })),
    });
    if (req.editing && !imageChoice.registryId) throw new Error(imageChoice.reason);
    const ordered = [
      imageChoice.registryId,
      ...imageModels.map((p) => p.config.id),
    ].filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index);
    const attempts = ordered.length ? ordered : [""];
    const failures: string[] = [];
    for (const id of attempts) {
      const provider = id
        ? this.modelService.registry.get(id)
        : req.modelId
          ? this.modelService.registry.get(req.modelId)
          : this.modelService.router.resolve("image");
      if (!provider) {
        failures.push(imageChoice.reason || `Unknown image model "${id || req.modelId || ""}"`);
        continue;
      }
      try {
        return await this.persistFromProvider(provider, req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const unavailable = /HTTP 404|not deployed|not found|does not support image/i.test(message);
        if (!unavailable || attempts.length === 1) throw err;
        failures.push(`${provider.config.id}: ${message}`);
      }
    }
    throw new Error(failures.join(" ") || "No image model could produce bytes.");
  }

  private async persistFromProvider(
    provider: { config: { id: string; endpoint: string; apiKey?: string; apiModelId?: string; capabilities: { image?: boolean } }; generateImage?: (request: { prompt: string; size?: string; n?: number; quality?: string; inputImage?: string }) => Promise<{ b64?: string; url?: string; revisedPrompt?: string }[]> },
    req: GenerateImageRequest
  ): Promise<{ model: string; images: GeneratedImage[] }> {
    const fireworks = provider.config.id.startsWith("fw:") && provider.config.capabilities.image && provider.config.apiKey && provider.config.apiModelId;
    let providerRequestId: string | undefined;
    let raw: { b64?: string; url?: string; revisedPrompt?: string }[];
    if (fireworks) {
      if (req.editing && !req.inputImage) throw new Error("Image edit requires a source image.");
      const kontext = new FireworksKontextProvider({
        endpoint: provider.config.endpoint,
        apiKey: provider.config.apiKey!,
        modelId: provider.config.apiModelId!,
      });
      const out = req.editing
        ? await kontext.editImage(req.prompt.trim(), req.inputImage!)
        : await kontext.generateImage(req.prompt.trim());
      providerRequestId = out.providerRequestId;
      raw = [{ b64: out.bytes.toString("base64") }];
    } else {
      if (!provider.generateImage) {
        throw new Error(`Model "${provider.config.id}" does not support image generation`);
      }
      raw = await provider.generateImage({
        prompt: req.prompt.trim(),
        size: req.size,
        n: Math.min(Math.max(req.n ?? 1, 1), 4),
        quality: req.quality ?? "high",
        inputImage: req.inputImage,
      });
    }

    const images: GeneratedImage[] = [];
    for (const item of raw) {
      const bytes = await bytesFromProviderItem(item);
      const sniffed = sniffImage(bytes);
      const requested = req.filename
        ? sanitizeArtifactName(req.filename)
        : slugName(req.prompt, images.length + 1);
      const filename = sniffed ? requested.replace(/\.[a-z0-9]+$/i, "") + sniffed.ext : requested;
      const mimeType = sniffed?.mime ?? "image/png";
      validateBytes(filename, mimeType, bytes);
      const rec = await this.artifacts.persistArtifact({
        name: filename,
        kind: "generated",
        bytes,
        mimeType,
        projectRoot: req.projectRoot ?? null,
        runId: req.runId ?? null,
        chatId: req.chatId ?? null,
        sourceTool: providerRequestId ? `fireworks:${provider.config.id}:${providerRequestId}` : "generate_image",
      });
      if (!rec.artifactId || rec.status !== "ready") {
        throw new Error("Image bytes were produced but artifact persistence did not reach ready.");
      }
      const back = await this.artifacts.read(rec.artifactId);
      if (!back.bytes.length || back.record.sha256 !== rec.sha256) {
        throw new Error("Image artifact read-back failed. No file was saved.");
      }
      const pub = this.artifacts.toToolResult(rec);
      images.push({
        filename: rec.name,
        artifactId: rec.artifactId,
        mimeType: rec.mimeType,
        size: rec.size,
        sha256: rec.sha256,
        providerRequestId,
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
