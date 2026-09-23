export interface GroundedArtifact {
  artifactId: string;
  name: string;
  mimeType?: string;
}

const CLAIM =
  /\b(generated|created file|download(?:able)?|attached|saved|files\s*→\s*generated|you'll find it|card above)\b/i;
const FILENAME = /\b[\w.-]+\.(png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx|csv|zip|txt|md|html|json)\b/gi;

export function looksLikeFileDeliverableRequest(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\.(png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx|csv|zip|txt|md|html)\b/i.test(t)) return true;
  return /\b(generate|create|make|draw|export|save)\b/i.test(t) &&
    /\b(logo|image|png|pdf|document|report|zip|spreadsheet|artifact|file)\b/i.test(t);
}

export function claimsGeneratedFile(text: string): boolean {
  FILENAME.lastIndex = 0;
  return CLAIM.test(text) || FILENAME.test(text);
}

/** Invented filenames that are not in the persisted set. */
export function inventedFilenames(text: string, artifacts: GroundedArtifact[]): string[] {
  const allowed = new Set(artifacts.map((a) => a.name.toLowerCase()));
  const found = String(text || "").match(FILENAME) ?? [];
  return [...new Set(found.map((n) => n.toLowerCase()))].filter((n) => !allowed.has(n));
}

/**
 * If the assistant claims a file exists without a persisted artifactId, rewrite.
 * Cards must never be inferred from this text.
 */
export function groundAssistantClaims(text: string, artifacts: GroundedArtifact[]): { text: string; blocked: boolean } {
  const list = artifacts.filter((a) => a.artifactId && a.name);
  if (list.length > 0) {
    const invented = inventedFilenames(text, list);
    if (invented.length === 0) return { text, blocked: false };
    const names = list.map((a) => a.name).join(", ");
    return {
      text: `Saved ${names}. Download or open it from the card — only those persisted files exist.`,
      blocked: true,
    };
  }
  if (!claimsGeneratedFile(text) && !looksLikeFileDeliverableRequest(text)) return { text, blocked: false };
  return {
    text: "No file was saved. Generation or persistence failed, so there is nothing to download and nothing in Files → Generated.",
    blocked: true,
  };
}

export function availableArtifactsPrompt(artifacts: GroundedArtifact[]): string {
  if (artifacts.length === 0) {
    return "PERSISTED ARTIFACTS: none. You must not say a file was generated, saved, attached, or is in Files → Generated. Do not invent a filename.";
  }
  const rows = artifacts.map((a) => `- artifactId=${a.artifactId} name=${a.name} mime=${a.mimeType ?? ""}`).join("\n");
  return `PERSISTED ARTIFACTS (only these exist; mention only these names):\n${rows}`;
}
