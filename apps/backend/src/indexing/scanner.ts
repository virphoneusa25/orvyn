// apps/backend/src/indexing/scanner.ts
import { promises as fs } from "fs";
import * as path from "path";

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".orvyn",
]);

// Skip obvious binaries/large-asset extensions rather than trying to index
// them as text — matches the spec's "large binaries" ignore requirement.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".7z",
  ".mp4", ".mov", ".mp3", ".wav",
  ".exe", ".dll", ".so", ".dylib",
  ".pdf",
]);

const MAX_FILE_BYTES = 500_000; // don't index huge generated files

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  content: string;
}

export async function scanProject(
  projectRoot: string,
  ignoreDirs: Set<string> = DEFAULT_IGNORE_DIRS
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".env") || entry.name.toLowerCase().includes("secret")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fs.readFile(fullPath, "utf-8");
          results.push({
            relativePath: toPosixRelative(projectRoot, fullPath),
            absolutePath: fullPath,
            content,
          });
        } catch {
          // Unreadable / non-UTF8 file — skip rather than fail the whole scan.
        }
      }
    }
  }

  await walk(projectRoot);
  return results;
}

export function toPosixRelative(projectRoot: string, fullPath: string): string {
  return path.relative(projectRoot, fullPath).split(path.sep).join("/");
}

export function shouldIgnoreRelative(
  relativePath: string,
  ignoreDirs: Set<string> = DEFAULT_IGNORE_DIRS
): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => ignoreDirs.has(p))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (base.startsWith(".env") || base.toLowerCase().includes("secret")) return true;
  const ext = path.extname(base).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
