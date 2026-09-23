// apps/backend/src/ai/tools/imageTool.ts
import { AITool, ToolResult } from "../ToolTypes";
import { ImageService } from "../../images/ImageService";
import { ModelService } from "../../services/ModelService";
import type { ArtifactService } from "../../artifacts/ArtifactService";

export function makeGenerateImageTool(
  projectRoot: string | undefined,
  modelService: ModelService,
  artifacts?: ArtifactService
): AITool {
  const images = new ImageService(modelService, artifacts);
  return {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using the configured image model. Saves a PNG in ORVYN artifact storage (Files → Generated) and returns a download path. Works without a local project folder. Requires approval because it costs money.",
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
        const artifactsOut = result.images.map((img, i) => ({
          index: i + 1,
          id: img.artifactId,
          name: img.filename,
          path: img.relativePath || img.path,
          mediaType: "image/png",
          downloadPath: img.artifactId ? `/artifacts/${img.artifactId}/download` : undefined,
          url: img.url,
        }));
        return {
          ok: true,
          output: JSON.stringify({
            message: `Generated ${result.images.length} image(s) with ${result.model}.`,
            artifacts: artifactsOut,
          }),
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
