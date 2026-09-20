import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { Tenant } from "../tenancy/TenantManager";

export async function resolveWorkspace(tenant: Pick<Tenant,"id"|"currentProjectRoot">, requested: unknown): Promise<string> {
  const root = typeof requested === "string" ? requested.trim() : "";
  const cloud = process.env.ORVYN_PROJECTS_DIR;
  if (cloud) {
    const base = path.resolve(cloud,tenant.id);
    await fs.mkdir(base,{recursive:true});
    if (!root) return fs.realpath(base);
    const target = path.resolve(root);
    const relative = path.relative(base,target);
    if (!path.isAbsolute(root) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("The cloud backend cannot access that local folder. Switch to Local Mode for files on this computer; attach documents to use the cloud document tools.");
    const realBase = await fs.realpath(base); const realTarget = await fs.realpath(target);
    const rel = path.relative(realBase,realTarget);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Workspace is outside your cloud project directory.");
    return realTarget;
  }
  const target = root || tenant.currentProjectRoot || path.join(os.homedir(),".orvyn","workspace");
  if (!root) await fs.mkdir(target,{recursive:true});
  if (!(await fs.stat(target)).isDirectory()) throw new Error("Select an existing project folder.");
  return fs.realpath(target);
}
