// Unified Workbench file model. UI never hardcodes Local vs Cloud vs artifact.

import type { WorkbenchEnvironment } from "./workbenchEnvironment.ts";

export type FileSourceKind = "local" | "cloud" | "sandbox" | "virtual" | "artifact" | "upload";
export type FileSourceBadge = "LOCAL" | "CLOUD" | "SANDBOX" | "GENERATED" | "UPLOAD" | "VIRTUAL";

export interface WorkspaceFileEntry {
  id?: string;
  name: string;
  path: string;
  source: FileSourceKind;
  badge?: FileSourceBadge;
  kind: string;
  mediaType?: string | null;
  bytes?: number;
  createdAt?: number;
  downloadUrl?: string;
  previewUrl?: string;
  runId?: string | null;
}

export interface WorkbenchFileSection {
  id: "project" | "generated" | "artifacts" | "uploads" | "recents" | "downloads";
  label: string;
  files: WorkspaceFileEntry[];
}

export interface WorkbenchFileTree {
  sections: WorkbenchFileSection[];
  hasProject: boolean;
  environment: WorkbenchEnvironment;
}

const SECTION_ORDER: WorkbenchFileSection["id"][] = [
  "project",
  "generated",
  "artifacts",
  "uploads",
  "recents",
  "downloads",
];

export function projectSourceForEnvironment(env: WorkbenchEnvironment): FileSourceKind {
  if (env === "cloud") return "cloud";
  if (env === "sandbox") return "sandbox";
  return "local";
}

export function projectBadgeForEnvironment(env: WorkbenchEnvironment): FileSourceBadge {
  if (env === "cloud") return "CLOUD";
  if (env === "sandbox") return "SANDBOX";
  return "LOCAL";
}

export function badgeForEntry(entry: Pick<WorkspaceFileEntry, "source" | "kind" | "badge">): FileSourceBadge | undefined {
  if (entry.badge) return entry.badge;
  if (entry.source === "upload" || entry.kind === "upload") return "UPLOAD";
  if (entry.source === "artifact" || entry.kind === "generated" || entry.kind === "artifact") return "GENERATED";
  if (entry.source === "virtual") return "VIRTUAL";
  if (entry.source === "cloud") return "CLOUD";
  if (entry.source === "sandbox") return "SANDBOX";
  if (entry.source === "local") return "LOCAL";
  return undefined;
}

/** Show a badge only when sources are mixed or the row is not in its obvious section. */
export function shouldShowBadge(sectionId: string, badge: FileSourceBadge | undefined, mixedSources: boolean): boolean {
  if (!badge) return false;
  if (sectionId === "generated" && badge === "GENERATED") return mixedSources;
  if (sectionId === "uploads" && badge === "UPLOAD") return false;
  if (sectionId === "project" && (badge === "LOCAL" || badge === "CLOUD" || badge === "SANDBOX" || badge === "VIRTUAL")) {
    return mixedSources;
  }
  return true;
}

export function normalizeRemoteFile(raw: Record<string, unknown>, fallbackSource: FileSourceKind): WorkspaceFileEntry {
  const kind = String(raw.kind ?? "file");
  const source = (raw.source as FileSourceKind | undefined) ?? inferSource(kind, fallbackSource);
  return {
    id: typeof raw.id === "string" ? raw.id : typeof raw.artifactId === "string" ? raw.artifactId : undefined,
    name: String(raw.name ?? fileName(String(raw.path ?? "file"))),
    path: String(raw.path ?? raw.name ?? ""),
    source,
    badge: raw.badge ? (String(raw.badge).toUpperCase() as FileSourceBadge) : badgeForEntry({ source, kind }),
    kind,
    mediaType: (raw.mediaType ?? raw.mimeType) as string | null | undefined,
    bytes: typeof raw.bytes === "number" ? raw.bytes : typeof raw.size === "number" ? raw.size : undefined,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
    downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : undefined,
    previewUrl: typeof raw.previewUrl === "string" ? raw.previewUrl : undefined,
    runId: typeof raw.runId === "string" ? raw.runId : null,
  };
}

function inferSource(kind: string, fallback: FileSourceKind): FileSourceKind {
  if (kind === "upload") return "upload";
  if (kind === "generated" || kind === "artifact" || kind === "document" || kind === "run") return "artifact";
  if (kind === "virtual") return "virtual";
  return fallback;
}

export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
}

export function mergeFileSections(
  remote: Array<{ id?: string; label?: string; files?: Record<string, unknown>[] }>,
  env: WorkbenchEnvironment,
  extras: WorkspaceFileEntry[] = []
): WorkbenchFileTree {
  const projectSource = projectSourceForEnvironment(env);
  const byId = new Map<WorkbenchFileSection["id"], WorkbenchFileSection>();
  for (const id of SECTION_ORDER) {
    byId.set(id, { id, label: defaultLabel(id), files: [] });
  }
  for (const loc of remote) {
    const id = loc.id === "run" ? "artifacts" : (loc.id as WorkbenchFileSection["id"]);
    if (!byId.has(id)) continue;
    const section = byId.get(id)!;
    if (loc.label) section.label = loc.label;
    const fallback = id === "project" ? projectSource : id === "uploads" ? "upload" : "artifact";
    for (const f of loc.files ?? []) {
      const entry = normalizeRemoteFile(f, fallback);
      if (!section.files.some((x) => x.path === entry.path && x.id === entry.id)) section.files.push(entry);
    }
  }
  const generated = byId.get("generated")!;
  const artifacts = byId.get("artifacts")!;
  const recents = byId.get("recents")!;
  for (const extra of extras) {
    const target = extra.kind === "artifact" || extra.source === "artifact" ? generated : extra.source === "upload" ? byId.get("uploads")! : artifacts;
    if (!target.files.some((f) => f.path === extra.path)) target.files.push(extra);
    if (!recents.files.some((f) => f.path === extra.path)) recents.files.unshift(extra);
  }
  recents.files = recents.files.slice(0, 24);
  const sections = orderSectionsForEnvironment(env).map((id) => byId.get(id)!);
  return {
    sections,
    hasProject: (byId.get("project")?.files.length ?? 0) > 0,
    environment: env,
  };
}

export function orderSectionsForEnvironment(env: WorkbenchEnvironment): WorkbenchFileSection["id"][] {
  const projectFirst: WorkbenchFileSection["id"][] = ["project", "generated", "artifacts", "uploads", "recents", "downloads"];
  if (env === "local") return projectFirst;
  return projectFirst;
}

export function searchFileTree(tree: WorkbenchFileTree, query: string): WorkspaceFileEntry[] {
  const q = query.trim().toLowerCase();
  const files = tree.sections.flatMap((s) => s.files);
  if (!q) return files;
  return files.filter((f) =>
    f.name.toLowerCase().includes(q) ||
    f.path.toLowerCase().includes(q) ||
    (f.mediaType ?? "").toLowerCase().includes(q) ||
    f.kind.toLowerCase().includes(q) ||
    (f.badge ?? "").toLowerCase().includes(q)
  );
}

export function isBinaryName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "zip", "docx", "xlsx", "pptx", "mp4", "woff", "woff2"].includes(ext);
}

export function isPreviewableName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "md", "txt", "json", "csv", "html", "htm"].includes(ext);
}

function defaultLabel(id: WorkbenchFileSection["id"]): string {
  if (id === "project") return "Project";
  if (id === "generated") return "Generated";
  if (id === "artifacts") return "Run Artifacts";
  if (id === "uploads") return "Uploads";
  if (id === "recents") return "Recents";
  return "Downloads";
}
