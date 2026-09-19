// apps/backend/src/ai/tools/imageTool.ts
import { AITool, ToolResult } from "../ToolTypes";
import { ImageService } from "../../images/ImageService";
import { ModelService } from "../../services/ModelService";

export function makeGenerateImageTool(projectRoot: string, modelService: ModelService): AITool {
  const images = new ImageService(modelService);
  return {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using the configured image model. Saves PNG files under .orvyn/generated/. Requires approval because it costs money.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw" },
        size: { type: "string", description: "Optional size like 1024x1024" },
      },
      required: ["prompt"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await images.generate({
          prompt: String(args.prompt ?? ""),
          size: args.size ? String(args.size) : undefined,
          projectRoot,
        });
        const lines = result.images.map((img, i) => {
          const loc = img.relativePath || img.url || "(in-memory)";
          return `${i + 1}. ${loc}`;
        });
        return {
          ok: true,
          output: `Generated ${result.images.length} image(s) with ${result.model}:\n${lines.join("\n")}`,
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
