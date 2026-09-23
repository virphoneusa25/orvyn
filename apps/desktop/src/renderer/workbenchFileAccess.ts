// Kind-based Files routing. Artifacts never go through project:readFile.

export type WorkbenchFileKind = "workspace-file" | "artifact" | "upload" | "run-artifact";

export interface WorkbenchFileItem {
  id: string;
  kind: WorkbenchFileKind;
  name: string;
  mimeType?: string | null;
  source: "local" | "cloud" | "sandbox" | "virtual" | "artifact" | "upload";
  path?: string;
  artifactId?: string;
  bytes?: number;
  createdAt?: number;
  downloadUrl?: string;
  previewUrl?: string;
  reference?: string;
}

export type FileReadVia = "artifact" | "workspace" | "none";
export type PreviewKind = "image" | "pdf" | "text" | "binary";

export function workbenchItemKind(input: {
  source?: string;
  kind?: string;
  artifactId?: string | null;
  id?: string | null;
}): WorkbenchFileKind {
  if (input.source === "upload" || input.kind === "upload") return "upload";
  if (input.kind === "run" || input.kind === "document") return "run-artifact";
  if (
    input.source === "artifact" ||
    input.kind === "artifact" ||
    input.kind === "generated" ||
    Boolean(input.artifactId) ||
    looksLikeArtifactId(input.id)
  ) {
    return "artifact";
  }
  return "workspace-file";
}

export function looksLikeArtifactId(value?: string | null): boolean {
  if (!value) return false;
  if (/^(art_|artifact_)[a-z0-9_-]+$/i.test(value)) return true;
  return /^[a-f0-9]{8,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{4,}$/i.test(value);
}

export function isFabricatedGeneratedPath(path?: string | null): boolean {
  if (!path) return false;
  const n = path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return /(^|\/)generated\//i.test(n) || /^generated(\/|$)/i.test(n);
}

export function fileReadPlan(item: Pick<WorkbenchFileItem, "kind" | "artifactId" | "path">): {
  via: FileReadVia;
  artifactId?: string;
  path?: string;
} {
  if (item.kind === "artifact" || item.kind === "run-artifact" || item.kind === "upload") {
    if (item.artifactId) return { via: "artifact", artifactId: item.artifactId };
    return { via: "none" };
  }
  if (isFabricatedGeneratedPath(item.path)) return { via: "none" };
  if (item.path) return { via: "workspace", path: item.path };
  return { via: "none" };
}

export function usesProjectReadFile(item: Pick<WorkbenchFileItem, "kind" | "artifactId" | "path">): boolean {
  return fileReadPlan(item).via === "workspace";
}

export function previewKind(mimeType?: string | null, name?: string): PreviewKind {
  const mime = (mimeType ?? "").toLowerCase();
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    ["md", "txt", "json", "csv", "html", "htm", "css", "js", "ts", "tsx", "xml", "yml", "yaml"].includes(ext)
  ) {
    return "text";
  }
  return "binary";
}

export function userFacingFileError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? "");
  if (/invoking remote method|project:readFile|enoent/i.test(raw)) {
    return "Could not open this file.";
  }
  if (/not found|404|unavailable/i.test(raw)) return "Artifact unavailable";
  return raw.slice(0, 160) || "Could not open this file.";
}

export function toWorkbenchFileItem(raw: {
  id?: string;
  artifactId?: string;
  name?: string;
  path?: string;
  source?: string;
  kind?: string;
  mediaType?: string | null;
  mimeType?: string | null;
  bytes?: number;
  createdAt?: number;
  downloadUrl?: string;
  previewUrl?: string;
}): WorkbenchFileItem {
  const artifactId = raw.artifactId || (looksLikeArtifactId(raw.id) ? raw.id : undefined);
  const kind = workbenchItemKind({ source: raw.source, kind: raw.kind, artifactId, id: raw.id });
  const name = raw.name || (raw.path ?? "file").replace(/\\/g, "/").split("/").pop() || "file";
  return {
    id: raw.id || artifactId || raw.path || name,
    kind,
    name,
    mimeType: raw.mimeType ?? raw.mediaType ?? null,
    source: (raw.source as WorkbenchFileItem["source"]) || (kind === "workspace-file" ? "local" : kind === "upload" ? "upload" : "artifact"),
    path: kind === "workspace-file" ? raw.path : undefined,
    artifactId,
    bytes: raw.bytes,
    createdAt: raw.createdAt,
    downloadUrl: raw.downloadUrl,
    previewUrl: raw.previewUrl,
    reference: artifactId ? `artifact:${artifactId}` : raw.path,
  };
}
