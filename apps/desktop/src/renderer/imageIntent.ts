// Detect when the user is asking for artwork so Chat can generate it
// from natural language — no extra button required.
//
// Keep this from catching code work: "create an image component" is not a picture.

export { looksLikeImageRequest, stripImagePrefix } from "../../../../packages/ai-core/src/imageIntent";

export async function requestGeneratedImages(
  prompt: string,
  projectRoot: string | null | undefined,
  apiUrl: (path: string) => string,
  authHeaders: () => Record<string, string>
): Promise<{ model?: string; images: { artifactId?: string; filename?: string; mimeType?: string; downloadUrl?: string; previewUrl?: string; dataUrl?: string; url?: string; relativePath?: string }[] }> {
  const res = await fetch(apiUrl("/images/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt, projectRoot: projectRoot ?? undefined, size: "1024x1024" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function formatImageMarkdown(data: {
  model?: string;
  images?: { artifactId?: string; filename?: string; downloadUrl?: string; previewUrl?: string; dataUrl?: string; url?: string; relativePath?: string }[];
}): string {
  const persisted = (data.images ?? []).filter((img) => img.artifactId);
  if (persisted.length === 0) {
    return "No file was saved. Image generation did not persist an artifact.";
  }
  const blocks = persisted
    .map((img) => `Persisted \`${img.filename ?? "image.png"}\` as artifact ${img.artifactId}. Open Preview, Download, or Files → Generated.`)
    .join("\n\n");
  const header = data.model ? `Generated with ${data.model}:\n\n` : "";
  return header + blocks;
}
