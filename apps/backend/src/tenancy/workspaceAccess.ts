// apps/backend/src/tenancy/workspaceAccess.ts
//
// THE tenant filesystem boundary. On a shared cloud host a customer's
// workspace path is only ever one of its OWN roots:
//   <ORVYN_PROJECTS_DIR>/<tenantId>/…          (projects checked out for it)
//   <ORVYN_DATA_DIR>/tenants/<tenantId>/…      (managed workspaces, virtual
//                                               workspace, artifacts)
// Any other server path a client names (another tenant's workspace, the data
// directory with auth.db, /etc…) is refused — it is never listed, read,
// indexed, adopted as a run's project, or mkdir'd.
// A desktop's own local engine (not a shared host) has one user and keeps its
// folders: the boundary applies only to a cloud host.

import { realpathSync } from "fs";
import path from "path";
import { defaultDataDir } from "../persistence/LocalStore";

export function sharedCloudHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVYN_CLOUD_MODE === "true" || Boolean(env.ORVYN_PROJECTS_DIR);
}

/** The roots a tenant may use on this host. */
export function tenantRoots(tenantId: string, env: NodeJS.ProcessEnv = process.env, dataDir: string = defaultDataDir()): string[] {
  const id = String(tenantId ?? "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") return [];
  const roots = [path.resolve(dataDir, "tenants", id)];
  if (env.ORVYN_PROJECTS_DIR) roots.push(path.resolve(env.ORVYN_PROJECTS_DIR, id));
  return roots;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A path that does not exist yet: resolve its nearest existing parent so a
    // symlink cannot smuggle a new folder outside the tenant.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(real(parent), path.basename(p));
  }
}

function inside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * May this tenant use `root` on this host? Always true on a single-user local
 * engine. On a shared host only its own roots (symlinks resolved).
 */
export function tenantMayUseRoot(tenantId: string, root: string | null | undefined, env: NodeJS.ProcessEnv = process.env, dataDir: string = defaultDataDir()): boolean {
  const text = String(root ?? "").trim();
  if (!text) return false;
  if (!sharedCloudHost(env)) return true;
  if (!path.isAbsolute(text)) return false;
  const target = real(path.resolve(text));
  return tenantRoots(tenantId, env, dataDir).some((base) => inside(real(base), target));
}
