import { promises as fs } from "fs";
import * as path from "path";

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

export interface SafePathOptions {
  /** When true, absolute paths inside the project are allowed. */
  allowAbsoluteInRoot?: boolean;
}

/**
 * Resolve a user/model path against the workspace root.
 * Blocks `..` traversal, unauthorized absolute paths, and (when the
 * filesystem is available) symlink / junction escapes.
 */
export function resolveSafePath(projectRoot: string, relativePath: string, opts: SafePathOptions = {}): string {
  const root = path.resolve(String(projectRoot || ""));
  const raw = String(relativePath ?? "").trim() || ".";
  if (TRAVERSAL.test(raw.replace(/\\/g, "/"))) {
    throw new Error(`Path "${relativePath}" escapes the project root — refused`);
  }
  if (path.isAbsolute(raw) && !opts.allowAbsoluteInRoot) {
    const abs = path.resolve(raw);
    if (!isContained(root, abs)) {
      throw new Error(`Path "${relativePath}" is outside the project root — refused`);
    }
    return abs;
  }
  const resolved = path.resolve(root, raw);
  if (!isContained(root, resolved)) {
    throw new Error(`Path "${relativePath}" escapes the project root — refused`);
  }
  return resolved;
}

export async function resolveSafeRealpath(projectRoot: string, relativePath: string): Promise<string> {
  const resolved = resolveSafePath(projectRoot, relativePath);
  const root = path.resolve(projectRoot);
  try {
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(resolved);
    if (!isContained(realRoot, realTarget)) {
      throw new Error(`Path "${relativePath}" escapes the project root via a link — refused`);
    }
    return realTarget;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // New files: verify the existing parent cannot escape.
      const parent = await existingParent(resolved);
      if (parent) {
        const realParent = await fs.realpath(parent);
        const realRoot = await fs.realpath(root).catch(() => root);
        if (!isContained(realRoot, realParent)) {
          throw new Error(`Path "${relativePath}" escapes the project root via a link — refused`);
        }
      }
      return resolved;
    }
    throw err;
  }
}

export function isContained(root: string, candidate: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  const rel = path.relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function existingParent(target: string): Promise<string | null> {
  let dir = path.dirname(target);
  for (let i = 0; i < 32; i++) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) return dir;
    } catch {
      /* keep walking up */
    }
    const next = path.dirname(dir);
    if (next === dir) return null;
    dir = next;
  }
  return null;
}
