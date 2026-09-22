import { createHash } from "crypto";
import { scanProject } from "./scanner";
import { gitRevision, logicalProjectId, type ProjectIdentity } from "./projectIdentity";

export type ProjectSourceKind = "local-upload" | "git" | "existing-worker-project" | "cloud-workspace";

export interface SnapshotFile {
  path: string;
  hash: string;
  size: number;
}

export interface ProjectSnapshot {
  tenantId: string;
  projectId: string;
  revision?: string;
  branch?: string;
  dirty?: boolean;
  source: ProjectSourceKind;
  files: SnapshotFile[];
  createdAt: string;
}

/** Logical identity + content hashes. Intelligence and worker sync share this, not a path. */
export async function buildProjectSnapshot(
  tenantId: string,
  projectRoot: string,
  opts: { projectId?: string; source?: ProjectSourceKind } = {}
): Promise<ProjectSnapshot> {
  const projectId = logicalProjectId(tenantId, projectRoot, opts.projectId);
  const git = await gitRevision(projectRoot);
  const scanned = await scanProject(projectRoot);
  const files: SnapshotFile[] = scanned.map((f) => ({
    path: f.relativePath,
    hash: createHash("sha256").update(f.content).digest("hex"),
    size: Buffer.byteLength(f.content),
  }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    tenantId,
    projectId,
    revision: git.revision,
    branch: git.branch,
    dirty: git.dirty,
    source: opts.source ?? (git.revision ? "git" : "local-upload"),
    files,
    createdAt: new Date().toISOString(),
  };
}

export function snapshotDiff(prev: ProjectSnapshot | undefined, next: ProjectSnapshot): {
  added: SnapshotFile[];
  changed: SnapshotFile[];
  removed: SnapshotFile[];
  unchanged: SnapshotFile[];
} {
  const before = new Map((prev?.files ?? []).map((f) => [f.path, f]));
  const after = new Map(next.files.map((f) => [f.path, f]));
  const added: SnapshotFile[] = [];
  const changed: SnapshotFile[] = [];
  const unchanged: SnapshotFile[] = [];
  const removed: SnapshotFile[] = [];
  for (const file of next.files) {
    const old = before.get(file.path);
    if (!old) added.push(file);
    else if (old.hash !== file.hash) changed.push(file);
    else unchanged.push(file);
  }
  for (const file of prev?.files ?? []) {
    if (!after.has(file.path)) removed.push(file);
  }
  return { added, changed, removed, unchanged };
}

export function identityOf(snapshot: ProjectSnapshot): ProjectIdentity {
  return {
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    branch: snapshot.branch,
    dirty: snapshot.dirty,
  };
}
