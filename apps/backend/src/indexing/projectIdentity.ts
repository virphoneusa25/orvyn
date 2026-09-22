import { createHash } from "crypto";
import { spawn } from "child_process";
import * as path from "path";

export interface ProjectIdentity {
  tenantId: string;
  projectId: string;
  revision?: string;
  branch?: string;
  dirty?: boolean;
}

/** Logical project id — tenant-scoped, not a mission-container path. */
export function logicalProjectId(tenantId: string, projectRoot: string, explicit?: string): string {
  if (explicit && /^[A-Za-z0-9._-]{2,80}$/.test(explicit)) return explicit;
  const posix = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = posix.split("/").filter(Boolean);
  const base = (parts[parts.length - 1] || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40);
  // Last two segments distinguish same-named folders without pinning a full machine path.
  const hint = parts.slice(-2).join("/").toLowerCase();
  const hash = createHash("sha1").update(`${tenantId}\n${hint}`).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

export function gitRevision(projectRoot: string): Promise<{ revision?: string; branch?: string; dirty: boolean }> {
  return new Promise((resolve) => {
    const git = (args: string[]) =>
      new Promise<string>((res, rej) => {
        const p = spawn("git", args, { cwd: projectRoot, windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", rej);
        p.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error("git " + args.join(" ")))));
      });
    Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["status", "--porcelain"]),
    ])
      .then(([revision, branch, dirty]) => resolve({ revision, branch, dirty: dirty.length > 0 }))
      .catch(() => resolve({ dirty: false }));
  });
}
