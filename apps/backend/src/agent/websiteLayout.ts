// A new website must not replace pages that are already in the project.
// When a site exists, the new one is written under sites/<name>/ and the
// earlier files stay where they are.

import { existsSync, readdirSync } from "fs";
import { join } from "path";

const SKIP = new Set(["node_modules", "dist", ".git", "previews", ".orvyn", "coverage", "build", "out"]);
const PAGE = /^index\.(html|php)$/i;
const ASSET = /\.(html|css|js|php)$/i;
const CREATE = /\b(build|create|make|design|generate)\b/i;
const SITE = /\b(website|web\s*site|landing\s*page|homepage|home\s*page)\b/i;
const REPLACE = /\b(replace|overwrite|redo|start over|from scratch)\b/i;

const ROOT_PROMPT =
  "This run is a website. Call write_file for index.html and its stylesheet. Do not open the sandbox desktop and do not start a shell server. The preview URL is the rendered site.";

export interface WebsiteLayout {
  /** Relative folder for the new site. Null when this run writes at the project root. */
  directory: string | null;
  protectedFiles: string[];
  prompt: string;
}

/** index pages and the html/css/js beside them, a few folders down. Skips dependency trees. */
export function listExistingSiteFiles(root: string): string[] {
  if (!root || !existsSync(root)) return [];
  const found = new Set<string>();
  const visit = (dir: string, rel: string, depth: number) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && PAGE.test(entry.name))) {
      for (const entry of entries) {
        if (entry.isFile() && ASSET.test(entry.name)) found.add(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
    if (depth >= 3) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      visit(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  visit(root, "", 0);
  return [...found].sort();
}

/** "Build a website" is a new site. "Replace the website" is an explicit overwrite. */
export function isNewWebsiteRequest(instruction: string): boolean {
  return CREATE.test(instruction) && SITE.test(instruction) && !REPLACE.test(instruction);
}

export function siteSlug(instruction: string): string {
  const stop = new Set([
    "build", "create", "make", "design", "generate", "simple", "website", "web", "site", "page",
    "landing", "homepage", "home", "for", "me", "please", "and", "with", "a", "an", "the", "my",
    "our", "new", "into", "using", "use", "small", "basic",
  ]);
  const words = instruction.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !stop.has(word));
  return words.slice(0, 3).join("-").slice(0, 40) || "site";
}

export function planWebsiteLayout(instruction: string, existing: string[]): WebsiteLayout {
  if (!isNewWebsiteRequest(instruction) || existing.length === 0) {
    return { directory: null, protectedFiles: [], prompt: ROOT_PROMPT };
  }
  const base = siteSlug(instruction);
  const taken = (dir: string) => existing.some((file) => file === dir || file.startsWith(`${dir}/`));
  let directory = `sites/${base}`;
  let n = 2;
  while (taken(directory)) directory = `sites/${base}-${n++}`;
  const shown = existing.slice(0, 8).join(", ");
  return {
    directory,
    protectedFiles: existing,
    prompt: `This run is a new website. These site files were already written and must stay as they are: ${shown}. Do not write_file, edit_file, or delete_file them. Write the new site under ${directory}/ as index.html and its stylesheet. Do not open the sandbox desktop and do not start a shell server. The preview URL is the new site.`,
  };
}

export function normalizeSitePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** True when this path is one of the pages that existed before the run. */
export function isProtectedSiteFile(layout: WebsiteLayout | undefined, filePath: string): boolean {
  if (!layout?.protectedFiles.length) return false;
  const rel = normalizeSitePath(filePath);
  return layout.protectedFiles.includes(rel);
}

const MUTATION = new Set(["write_file", "edit_file", "delete_file", "move_file"]);

export function siteWriteRefusal(layout: WebsiteLayout | undefined, tool: string, filePath: string): string | null {
  if (!MUTATION.has(tool) || !isProtectedSiteFile(layout, filePath)) return null;
  const rel = normalizeSitePath(filePath);
  const dir = layout?.directory ?? "a new folder";
  return `Refusing to replace ${rel}. That file was already written. Leave it, and write the new site under ${dir}/.`;
}
