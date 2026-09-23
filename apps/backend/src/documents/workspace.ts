import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { defaultDataDir } from "../persistence/LocalStore";

/** Tenant-scoped virtual workspace. Cloud Mode writes here when the client
 *  sends a machine-local folder the control plane cannot see. */
export function virtualWorkspaceRoot(tenantId: string, dataDir: string = defaultDataDir()): string {
  return path.join(dataDir, "tenants", tenantId, "virtual-workspace");
}

/** Blob store for generated images, documents, downloads, and uploads. */
export function artifactStorageRoot(tenantId: string, dataDir: string = defaultDataDir()): string {
  return path.join(dataDir, "tenants", tenantId, "artifacts");
}

export function isVirtualWorkspace(root: string, tenantId: string, dataDir: string = defaultDataDir()): boolean {
  const virtual = path.resolve(virtualWorkspaceRoot(tenantId, dataDir));
  const target = path.resolve(root);
  const rel = path.relative(virtual, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path the OVH worker can actually copy. A Windows path from the desktop is not on the worker. */
export function cloudWorkerSourcePath(projectRoot: string): string {
  const root = String(projectRoot ?? "").trim();
  if (!root || looksLikeForeignAbsolutePath(root)) return "";
  return root;
}

/** A path that belongs to the other OS — never treat a real local folder as foreign. */
export function looksLikeForeignAbsolutePath(p: string): boolean {
  if (process.platform === "win32") {
    return p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.startsWith("\\\\");
  }
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

/**
 * Resolve a client-supplied project root.
 *
 * Local filesystem is an execution option, not a prerequisite. When Cloud
 * receives a folder it cannot stat (typical: a Windows path from desktop),
 * we fall back to the tenant virtual workspace instead of rejecting the run.
 * We never silently substitute a random home folder as "the project".
 */
export async function resolveWorkspace(tenant: { id: string; currentProjectRoot?: string | null }, requested: unknown): Promise<string> {
  const root = typeof requested === "string" ? requested.trim() : "";
  const cloud = process.env.ORVYN_PROJECTS_DIR;
  if (cloud) {
    const base = path.resolve(cloud, tenant.id);
    await fs.mkdir(base, { recursive: true });
    if (!root || looksLikeForeignAbsolutePath(root)) {
      return ensureDir(virtualWorkspaceRoot(tenant.id));
    }
    const target = path.resolve(root);
    const relative = path.relative(base, target);
    if (!path.isAbsolute(root) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return ensureDir(virtualWorkspaceRoot(tenant.id));
    }
    try {
      const realBase = await fs.realpath(base);
      const realTarget = await fs.realpath(target);
      const rel = path.relative(realBase, realTarget);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return ensureDir(virtualWorkspaceRoot(tenant.id));
      }
      return realTarget;
    } catch {
      return ensureDir(virtualWorkspaceRoot(tenant.id));
    }
  }
  if (!root) {
    const fallback = tenant.currentProjectRoot;
    if (fallback) {
      try {
        if ((await fs.stat(fallback)).isDirectory()) return fs.realpath(fallback);
      } catch {
        /* use virtual workspace */
      }
    }
    return ensureDir(virtualWorkspaceRoot(tenant.id));
  }
  if (looksLikeForeignAbsolutePath(root)) {
    return ensureDir(virtualWorkspaceRoot(tenant.id));
  }
  const target = root;
  try {
    if (!(await fs.stat(target)).isDirectory()) {
      return ensureDir(virtualWorkspaceRoot(tenant.id));
    }
    return fs.realpath(target);
  } catch {
    return ensureDir(virtualWorkspaceRoot(tenant.id));
  }
}

/** Kept for callers that still want a default local scratch when not cloud. */
export function defaultLocalWorkspace(): string {
  return path.join(os.homedir(), ".orvyn", "workspace");
}
