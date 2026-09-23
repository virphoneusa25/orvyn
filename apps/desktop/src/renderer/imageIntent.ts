// Detect when the user is asking for artwork so Chat can generate it
// from natural language — no extra button required.
//
// Keep this from catching code work: "create an image component" is not a picture.

export function looksLikeImageRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\/image\b/i.test(t)) return true;

  const coding =
    /\b(component|element|tag|jsx|tsx|html|css|react|div|img\s+tag|src=)\b/i.test(t) &&
    !/\b(draw|paint|sketch|render|mock-?up|logo|icon)\b/i.test(t);
  if (coding) return false;

  const artNoun =
    /\b(images?|pictures?|photos?|icons?|logos?|illustrations?|artwork|mock-?ups?|banners?|thumbnails?)\b/i;
  const artVerb =
    /\b(generate|draw|render|paint|sketch|imagine|design|make|create|mock-?up)\b/i;
  const logoFor = /\b(logo|icon|illustration|artwork|mock-?up)\b.{0,48}\b(for|of|that)\b/i;
  const asked =
    /\b(can you|could you|please|i (?:need|want)|make me|design me)\b/i.test(t) && artNoun.test(t);

  return (artVerb.test(t) && artNoun.test(t)) || logoFor.test(t) || asked;
}

export function stripImagePrefix(text: string): string {
  return text.replace(/^\/image\b\s*/i, "").trim();
}

export async function requestGeneratedImages(
  prompt: string,
  projectRoot: string | null | undefined,
  apiUrl: (path: string) => string,
  authHeaders: () => Record<string, string>
): Promise<string> {
  const res = await fetch(apiUrl("/images/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt, projectRoot: projectRoot ?? undefined, size: "1024x1024" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return formatImageMarkdown(data);
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
