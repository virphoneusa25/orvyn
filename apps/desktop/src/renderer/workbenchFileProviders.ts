// Named file sources. React never branches on Local vs Cloud vs artifact.

import type { WorkbenchEnvironment } from "./workbenchEnvironment.ts";
import { isFabricatedGeneratedPath } from "./workbenchFileAccess.ts";
import {
  fileName,
  mergeFileSections,
  normalizeRemoteFile,
  type FileSourceKind,
  type WorkbenchFileTree,
  type WorkspaceFileEntry,
} from "./workbenchFiles.ts";

export interface WorkbenchFileContext {
  environment: WorkbenchEnvironment;
  projectRoot?: string | null;
  locations: Array<{ id?: string; label?: string; files?: Record<string, unknown>[] }>;
  extras?: WorkspaceFileEntry[];
}

export interface WorkbenchFileProvider {
  readonly id: string;
  readonly source: FileSourceKind;
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[];
}

function sectionFiles(
  ctx: WorkbenchFileContext,
  sectionId: string,
  fallback: FileSourceKind
): WorkspaceFileEntry[] {
  const loc = ctx.locations.find((l) => l.id === sectionId || (sectionId === "artifacts" && l.id === "run"));
  return (loc?.files ?? []).map((f) => normalizeRemoteFile(f, fallback));
}

export class LocalFileProvider implements WorkbenchFileProvider {
  readonly id = "local";
  readonly source: FileSourceKind = "local";
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[] {
    if (ctx.environment !== "local") return [];
    return sectionFiles(ctx, "project", "local");
  }
}

export class CloudFileProvider implements WorkbenchFileProvider {
  readonly id = "cloud";
  readonly source: FileSourceKind = "cloud";
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[] {
    if (ctx.environment !== "cloud") return [];
    return sectionFiles(ctx, "project", "cloud");
  }
}

export class SandboxFileProvider implements WorkbenchFileProvider {
  readonly id = "sandbox";
  readonly source: FileSourceKind = "sandbox";
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[] {
    if (ctx.environment !== "sandbox") return [];
    return sectionFiles(ctx, "project", "sandbox");
  }
}

export class ArtifactFileProvider implements WorkbenchFileProvider {
  readonly id = "artifact";
  readonly source: FileSourceKind = "artifact";
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[] {
    const generated = sectionFiles(ctx, "generated", "artifact");
    const run = sectionFiles(ctx, "artifacts", "artifact");
    const extras = (ctx.extras ?? []).filter((e) => e.source === "artifact" || e.kind === "artifact" || e.kind === "generated");
    return [...generated, ...run, ...extras];
  }
}

export class UploadFileProvider implements WorkbenchFileProvider {
  readonly id = "upload";
  readonly source: FileSourceKind = "upload";
  list(ctx: WorkbenchFileContext): WorkspaceFileEntry[] {
    const uploads = sectionFiles(ctx, "uploads", "upload");
    const extras = (ctx.extras ?? []).filter((e) => e.source === "upload" || e.kind === "upload");
    return [...uploads, ...extras];
  }
}

export const WORKBENCH_FILE_PROVIDERS: WorkbenchFileProvider[] = [
  new LocalFileProvider(),
  new CloudFileProvider(),
  new SandboxFileProvider(),
  new ArtifactFileProvider(),
  new UploadFileProvider(),
];

export function projectProviderFor(env: WorkbenchEnvironment): WorkbenchFileProvider {
  if (env === "cloud") return new CloudFileProvider();
  if (env === "sandbox") return new SandboxFileProvider();
  return new LocalFileProvider();
}

/** Compose ArtifactService locations + live extras through named providers. */
export function composeWorkbenchFileTree(ctx: WorkbenchFileContext): WorkbenchFileTree {
  const project = projectProviderFor(ctx.environment).list(ctx);
  const generated = new ArtifactFileProvider().list(ctx).filter((f) => f.kind === "generated" || f.kind === "artifact");
  const run = new ArtifactFileProvider().list(ctx).filter((f) => f.kind === "document" || f.kind === "run" || f.kind === "file");
  const uploads = new UploadFileProvider().list(ctx);
  const recents = sectionFiles(ctx, "recents", "artifact");
  const downloads = sectionFiles(ctx, "downloads", "artifact");
  return relocateFabricatedGeneratedFiles(
    mergeFileSections(
      [
        { id: "project", label: "Project", files: project as unknown as Record<string, unknown>[] },
        { id: "generated", label: "Generated", files: generated as unknown as Record<string, unknown>[] },
        { id: "artifacts", label: "Run Artifacts", files: run as unknown as Record<string, unknown>[] },
        { id: "uploads", label: "Uploads", files: uploads as unknown as Record<string, unknown>[] },
        { id: "recents", label: "Recents", files: recents as unknown as Record<string, unknown>[] },
        { id: "downloads", label: "Downloads", files: downloads as unknown as Record<string, unknown>[] },
      ],
      ctx.environment,
      ctx.extras ?? []
    )
  );
}

/**
 * Older workers still list `generated/...` under Project. Those paths are
 * artifact copies, not workspace files. Drop them when Generated already
 * has the same name; otherwise move the row into Generated.
 */
export function relocateFabricatedGeneratedFiles(tree: WorkbenchFileTree): WorkbenchFileTree {
  const project = tree.sections.find((s) => s.id === "project");
  const generated = tree.sections.find((s) => s.id === "generated");
  if (!project || !generated) return tree;
  const kept: WorkspaceFileEntry[] = [];
  for (const file of project.files) {
    if (!isFabricatedGeneratedPath(file.path) && !isFabricatedGeneratedPath(file.name)) {
      kept.push(file);
      continue;
    }
    const name = fileName(file.path || file.name);
    const already = generated.files.some((row) => row.name === name || fileName(row.path) === name);
    if (already) continue;
    generated.files.push({
      ...file,
      name,
      kind: "generated",
      source: "artifact",
      badge: "GENERATED",
    });
  }
  project.files = kept;
  return { ...tree, hasProject: project.files.length > 0 };
}

export function resolveProjectFetchRoot(projectRoot: string | null, cloudBackend: boolean): string | null {
  if (!projectRoot) return null;
  const foreign = /^[A-Za-z]:[\\/]/.test(projectRoot) || projectRoot.startsWith("\\\\");
  if (cloudBackend && foreign) return null;
  return projectRoot;
}
