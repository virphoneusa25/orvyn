import { looksLikeImageRequest, stripImagePrefix } from "@orvyn/ai-core";
export { looksLikeImageRequest, stripImagePrefix };

/** Capability search: image generation is a core ORVYN tool, not an MCP server. */
export function builtinImageGenerateHit(query: string): boolean {
  return /\b(image|picture|photo|logo|illustration|artwork|mock-?up|dall-?e|text[- ]to[- ]image|generate_image)\b/i.test(query);
}
