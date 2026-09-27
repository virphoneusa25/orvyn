// Canonical project files live under ORVYN_DATA_DIR
// (tenants/<tenantId>/workspaces/<workspaceId>), on the Cloud volume.
// A worker sandbox is ephemeral: stage copies the canonical tree in,
// and sync copies bytes back out. Sync adds and overwrites. It does not
// delete canonical files that the sandbox no longer has, so a partial
// or empty sandbox cannot wipe the project.

import * as fs from "fs";
import * as path from "path";

export interface WorkspaceFile {
  path: string;
  contentBase64: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 4000;

export function normalizeWorkspacePath(filePath: string): string {
  const rel = String(filePath ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!rel || rel === ".") return "";
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || SKIP_DIRS.has(part))) return "";
  return parts.join("/");
}

function assertInside(root: string, target: string): void {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path escapes workspace");
  }
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function assertDistinct(canonical: string, sandbox: string): void {
  if (pathsOverlap(canonical, sandbox)) {
    throw new Error("sandbox and canonical workspace must be different directories");
  }
}

export function readWorkspaceTree(root: string): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return files;
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      const rel = normalizeWorkspacePath(path.relative(base, abs));
      if (!rel) continue;
      const size = fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) continue;
      files.push({ path: rel, contentBase64: fs.readFileSync(abs).toString("base64") });
      if (files.length >= MAX_FILES) return;
    }
  };
  walk(base);
  return files;
}

export function writeWorkspaceTree(root: string, files: WorkspaceFile[]): string[] {
  const base = path.resolve(root);
  fs.mkdirSync(base, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const rel = normalizeWorkspacePath(file.path);
    if (!rel) continue;
    const buf = Buffer.from(String(file.contentBase64 ?? ""), "base64");
    if (buf.length > MAX_FILE_BYTES) continue;
    const target = path.resolve(base, rel);
    assertInside(base, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    written.push(rel);
  }
  return written;
}

/** Copy the durable project into an ephemeral sandbox. */
export function stageCanonicalWorkspace(canonical: string, sandbox: string): string[] {
  assertDistinct(canonical, sandbox);
  const files = readWorkspaceTree(canonical);
  return writeWorkspaceTree(sandbox, files);
}

/** Copy sandbox bytes onto the durable project. Existing canonical files stay. */
export function syncSandboxToCanonical(sandbox: string, canonical: string): string[] {
  assertDistinct(canonical, sandbox);
  return writeWorkspaceTree(canonical, readWorkspaceTree(sandbox));
}

/** Remove an ephemeral sandbox. Refuses to delete the canonical workspace. */
export function destroySandbox(sandbox: string, canonical: string): void {
  if (pathsOverlap(sandbox, canonical)) {
    throw new Error("refusing to delete canonical workspace");
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
