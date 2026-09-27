// Lightweight identity of a project tree. A different mount path is not a
// different project; this fingerprint is what the next mission compares.

import { createHash } from "crypto";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

const SKIP = new Set(["node_modules", "dist", ".git", "previews", ".orvyn", "coverage", "build", "out"]);

export interface WorkspaceFingerprint {
  projectId: string;
  workspaceId: string;
  fileCount: number;
  repository?: boolean;
  branch?: string;
  gitHead?: string;
  manifestHash?: string;
  importantPathsHash?: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function listFiles(root: string, limit = 500): string[] {
  if (!root || !existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string, rel: string, depth: number) => {
    if (found.length >= limit || depth > 4) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), child, depth + 1);
      else if (entry.isFile()) found.push(child);
    }
  };
  visit(root, "", 0);
  return found.sort();
}

export function computeWorkspaceFingerprint(projectId: string, workspaceId: string, root: string, git?: { branch?: string; head?: string }): WorkspaceFingerprint {
  const files = listFiles(root);
  const important = files.filter((file) => /^(index\.html|styles\.css|script\.js|package\.json)$/.test(file) || file.startsWith("public/") || /\.(html?|svg|css|js)$/.test(file));
  let repository = false;
  try {
    repository = statSync(path.join(root, ".git")).isDirectory();
  } catch {
    repository = false;
  }
  return {
    projectId,
    workspaceId,
    fileCount: files.length,
    repository,
    branch: git?.branch,
    gitHead: git?.head,
    manifestHash: hash(files.join("\n")),
    importantPathsHash: hash(important.join("\n")),
  };
}
