import type { ToolResult } from "../ai/ToolTypes";

export const FILE_PRODUCING_TOOLS = new Set([
  "generate_image",
  "create_document",
  "create_zip",
  "artifact_create",
  "artifact_write",
]);

export interface ToolArtifactResult {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  previewUrl?: string;
  downloadUrl?: string;
  kind?: string;
}

export function publicUrls(artifactId: string, previewable = false): { downloadUrl: string; previewUrl?: string } {
  return {
    downloadUrl: `/artifacts/${artifactId}/download`,
    ...(previewable ? { previewUrl: `/artifacts/${artifactId}/preview` } : {}),
  };
}

export function successArtifactPayload(art: ToolArtifactResult): Record<string, unknown> {
  return {
    status: "success",
    artifactId: art.artifactId,
    name: art.name,
    mimeType: art.mimeType,
    size: art.size,
    sha256: art.sha256,
    previewUrl: art.previewUrl,
    downloadUrl: art.downloadUrl ?? `/artifacts/${art.artifactId}/download`,
    artifacts: [art],
  };
}

export function errorArtifactPayload(code: string, message: string): Record<string, unknown> {
  return { status: "error", code, message };
}

export function parsePersistedArtifacts(raw: string | undefined, extra?: ToolArtifactResult[]): ToolArtifactResult[] {
  const out: ToolArtifactResult[] = [...(extra ?? [])];
  if (!raw) return out.filter((a) => a.artifactId);
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.artifacts)
      ? parsed.artifacts
      : parsed?.artifactId || parsed?.id
        ? [parsed]
        : [];
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const artifactId = String(a.artifactId ?? a.id ?? "");
      if (!artifactId) continue;
      out.push({
        artifactId,
        name: String(a.name ?? "file"),
        mimeType: String(a.mimeType ?? a.mediaType ?? "application/octet-stream"),
        size: Number(a.size ?? a.bytes ?? 0),
        sha256: a.sha256 ? String(a.sha256) : undefined,
        previewUrl: a.previewUrl ? String(a.previewUrl) : undefined,
        downloadUrl: a.downloadUrl ?? a.downloadPath ?? `/artifacts/${artifactId}/download`,
        kind: a.kind ? String(a.kind) : undefined,
      });
    }
  } catch {
    /* not JSON */
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    if (!a.artifactId || seen.has(a.artifactId)) return false;
    seen.add(a.artifactId);
    return true;
  });
}

/** File-producing tools cannot return ok without a persisted artifactId. */
export function requirePersistedArtifacts(tool: string, result: ToolResult): ToolResult {
  if (!FILE_PRODUCING_TOOLS.has(tool)) return result;
  if (!result.ok) return result;
  const persisted = parsePersistedArtifacts(result.output, result.artifacts);
  if (persisted.length === 0) {
    return {
      ok: false,
      error: "Generation produced no persisted artifact. No file was saved.",
    };
  }
  return { ...result, artifacts: persisted };
}
