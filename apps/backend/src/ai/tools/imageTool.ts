// apps/backend/src/ai/tools/imageTool.ts
import { AITool, ToolResult } from "../ToolTypes";
import { ImageService } from "../../images/ImageService";
import { ModelService } from "../../services/ModelService";
import type { ArtifactService } from "../../artifacts/ArtifactService";
import { errorArtifactPayload, successArtifactPayload } from "../../artifacts/artifactContract";

export function makeGenerateImageTool(
  projectRoot: string | undefined,
  modelService: ModelService,
  artifacts: ArtifactService
): AITool {
  const images = new ImageService(modelService, artifacts);
  return {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using the configured image model. Success only after PNG bytes are persisted as an ORVYN artifact (Files → Generated). Works without a local project folder. Requires approval because it costs money.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw" },
        size: { type: "string", description: "Optional size like 1024x1024" },
        filename: { type: "string", description: "Optional filename such as virphone-logo.png" },
      },
      required: ["prompt"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await images.generate({
          prompt: String(args.prompt ?? ""),
          size: args.size ? String(args.size) : undefined,
          filename: args.filename ? String(args.filename) : undefined,
          projectRoot,
        });
        const first = result.images[0];
        if (!first?.artifactId) {
          return {
            ok: false,
            error: "Image generation produced no persisted artifact.",
            output: JSON.stringify(errorArtifactPayload("NO_ARTIFACT", "Image generation produced no persisted artifact.")),
          };
        }
        const artifactsOut = result.images.map((img) => ({
          artifactId: img.artifactId,
          name: img.filename,
          mimeType: img.mimeType,
          size: img.size,
          sha256: img.sha256,
          downloadUrl: img.downloadUrl,
          previewUrl: img.previewUrl,
          kind: "generated",
        }));
        return {
          ok: true,
          artifacts: artifactsOut,
          output: JSON.stringify({
            ...successArtifactPayload(artifactsOut[0]),
            model: result.model,
            artifacts: artifactsOut,
            message: `Persisted ${first.filename} as artifact ${first.artifactId}.`,
          }),
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
          output: JSON.stringify(errorArtifactPayload("GENERATE_IMAGE_FAILED", err.message)),
        };
      }
    },
  };
}
