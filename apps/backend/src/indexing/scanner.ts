import { promises as fs } from "fs";
import * as path from "path";
import {
  BINARY_EXTENSIONS,
  IGNORE_DIRS,
  MAX_FILE_BYTES,
  isSecretPath,
  loadIgnoreGlobs,
  shouldIgnoreRelative as ignorePath,
  skipReason,
} from "./ignoreRules";

export const DEFAULT_IGNORE_DIRS = IGNORE_DIRS;

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  content: string;
  skipReason?: string;
}

export async function scanProject(
  projectRoot: string,
  ignoreDirs: Set<string> = IGNORE_DIRS
): Promise<ScannedFile[]> {
  const extra = await loadIgnoreGlobs(projectRoot);
  const results: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = toPosixRelative(projectRoot, fullPath);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name) || ignorePath(rel + "/", extra)) continue;
        await walk(fullPath);
      } else {
        try {
          const stat = await fs.stat(fullPath);
          const reason = skipReason(rel, stat.size, extra);
          if (reason) continue;
          if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
          if (isSecretPath(rel)) continue;
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fs.readFile(fullPath, "utf-8");
          if (content.includes("\0")) continue;
          results.push({
            relativePath: rel,
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

/** Back-compat for IndexService.watch */
export function shouldIgnoreRelative(
  relativePath: string,
  ignoreDirs: Set<string> = IGNORE_DIRS
): boolean {
  if ([...ignoreDirs].some((d) => relativePath.split(/[\\/]/).includes(d))) return true;
  return ignorePath(relativePath);
}
