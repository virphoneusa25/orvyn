// Serves a directory the agent already wrote. This module does not author pages.

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { defaultDataDir } from "../persistence/LocalStore";
import { join, normalize, extname, sep, isAbsolute } from "path";

const roots = new Map<string, string>();
// Previews live in the data directory (a persistent volume in the cloud), so a
// preview link still opens after the engine restarts or is redeployed.
function previewBase(): string {
  return join(defaultDataDir(), "previews");
}
const rootIndex = () => join(previewBase(), "roots.json");
let rootsLoaded = false;

function loadRoots(): void {
  if (rootsLoaded) return;
  rootsLoaded = true;
  try {
    const saved = JSON.parse(readFileSync(rootIndex(), "utf8")) as Record<string, string>;
    for (const [id, dir] of Object.entries(saved)) {
      if (typeof dir === "string" && existsSync(dir)) roots.set(id, dir);
    }
  } catch { /* first publish */ }
}

function saveRoot(id: string, dir: string): void {
  roots.set(id, dir);
  loadRoots();
  const all: Record<string, string> = {};
  for (const [key, value] of roots) all[key] = value;
  mkdirSync(previewBase(), { recursive: true });
  writeFileSync(rootIndex(), JSON.stringify(all));
}
const publishedIds = new Map<string, string>();
const remembered = new Map<string, Map<string, string>>();
let publicOrigin = (process.env.ORVYN_PUBLIC_ORIGIN || "").replace(/\/$/, "");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".php": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/plain; charset=utf-8",
};

export function notePublicOrigin(proto: string, host: string): void {
  if (process.env.ORVYN_PUBLIC_ORIGIN?.trim()) return;
  const cleanHost = host.split(",")[0]?.trim();
  if (!cleanHost) return;
  publicOrigin = `${(proto.split(",")[0]?.trim() || "https")}://${cleanHost}`;
}

export function previewUrl(id: string): string {
  const base = publicOrigin || "http://127.0.0.1:4570";
  return `${base}/api/v1/sites/${id}/`;
}

/** Keep a file the agent just wrote, keyed by run, so the preview does not depend on the project disk. */
export function rememberSiteFile(runId: string, relPath: string, content: string): void {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return;
  const bag = remembered.get(runId) ?? new Map<string, string>();
  bag.set(rel, content);
  remembered.set(runId, bag);
}

/** True when the page already loads this file with a <link href> or <script src>. */
function pageLoads(html: string, pageKey: string, file: string): boolean {
  const pageDir = pageKey.includes("/") ? pageKey.slice(0, pageKey.lastIndexOf("/") + 1) : "";
  const rel = file.startsWith(pageDir) ? file.slice(pageDir.length) : file;
  const re = /<(?:link|script)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const ref = m[1]!.split(/[?#]/)[0]!.replace(/^\.\//, "").replace(/^\//, "");
    if (ref === rel || ref === file) return true;
  }
  return false;
}

/**
 * One document: the page as the agent wrote it, plus any stylesheet or
 * script the agent wrote but the page does not load. Files the page does
 * load are served as files, so a later fix to them is what the preview shows.
 * Always composed from the latest files; the stored page is never rewritten.
 */
export function composeSiteDocument(runId: string): string | null {
  const bag = remembered.get(runId);
  if (!bag) return null;
  const pageKey = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  if (!pageKey) return null;
  let html = bag.get(pageKey) ?? "";
  const unloaded = (ext: string) => [...bag.entries()].filter(([name]) => name.endsWith(ext) && !pageLoads(html, pageKey, name)).map(([, body]) => body);
  const css = unloaded(".css").join("\n");
  const js = unloaded(".js").join("\n");
  if (css) {
    const style = `<style>\n${css}\n</style>`;
    html = html.includes("</head>") ? html.replace("</head>", `${style}\n</head>`) : style + html;
  }
  if (js) {
    const script = `<script>\n${js}\n</script>`;
    html = html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : html + script;
  }
  return html;
}

/** Write the remembered pages to one stable folder. Later files update that same URL. */
export function publishRememberedSite(runId: string): { id: string; url: string; files: string[] } | null {
  const bag = remembered.get(runId);
  if (!bag || ![...bag.keys()].some((name) => /(^|\/)index\.(html|php)$/i.test(name))) return null;
  const composed = composeSiteDocument(runId);
  const pageKey = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  const dir = join(previewBase(), runId);
  for (const [rel, content] of bag) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, rel === pageKey && composed ? composed : content);
  }
  const pageDir = pageKey && pageKey.includes("/") ? pageKey.slice(0, pageKey.lastIndexOf("/")) : "";
  const root = pageDir ? join(dir, pageDir) : dir;
  const id = publishedIds.get(runId) ?? randomUUID();
  publishedIds.set(runId, id);
  saveRoot(id, root);
  return { id, url: previewUrl(id), files: [...bag.keys()] };
}

/** Publish a folder the agent wrote. Returns a URL only when that folder has a page. */
export function publishAgentSite(dir: string): { id: string; url: string } | null {
  if (!dir || !existsSync(dir)) return null;
  const page = ["index.html", "index.php"].find((name) => existsSync(join(dir, name)));
  if (!page) return null;
  const id = randomUUID();
  saveRoot(id, dir);
  return { id, url: previewUrl(id) };
}

export function readPublishedFile(id: string, rel: string): { body: Buffer; contentType: string } | undefined {
  loadRoots();
  const root = roots.get(id);
  if (!root) return undefined;
  const safe = normalize(rel || "index.html").replace(/^(\.\.(\/|\\|$))+/, "");
  if (!safe || safe.startsWith("..") || safe.includes("\0") || isAbsolute(safe)) return undefined;
  const abs = join(root, safe === "." ? "index.html" : safe);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (!abs.startsWith(rootPrefix)) return undefined;
  const ext = extname(abs).toLowerCase();
  const index = join(root, "index.html");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    if ((!ext || ext === ".html") && existsSync(index)) return { body: readFileSync(index), contentType: TYPES[".html"] };
    return undefined;
  }
  const contentType = TYPES[ext];
  if (!contentType) return undefined;
  return { body: readFileSync(abs), contentType };
}
