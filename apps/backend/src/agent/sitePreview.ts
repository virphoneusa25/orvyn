// Serves a directory the agent already wrote. This module does not author pages.

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { defaultDataDir } from "../persistence/LocalStore";
import { join, normalize, extname, sep, isAbsolute } from "path";

const roots = new Map<string, string>();
/** The project folder behind a preview: a linked file the preview folder lacks is read from here. */
const sources = new Map<string, string>();
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
    const saved = JSON.parse(readFileSync(rootIndex(), "utf8")) as Record<string, string | { dir: string; source?: string }>;
    for (const [id, entry] of Object.entries(saved)) {
      const dir = typeof entry === "string" ? entry : entry?.dir;
      if (typeof dir === "string" && existsSync(dir)) roots.set(id, dir);
      if (entry && typeof entry === "object" && typeof entry.source === "string") sources.set(id, entry.source);
    }
  } catch { /* first publish */ }
}

function saveRoot(id: string, dir: string, source?: string): void {
  roots.set(id, dir);
  if (source) sources.set(id, source);
  loadRoots();
  const all: Record<string, string | { dir: string; source: string }> = {};
  for (const [key, value] of roots) {
    const src = sources.get(key);
    all[key] = src ? { dir: value, source: src } : value;
  }
  mkdirSync(previewBase(), { recursive: true });
  writeFileSync(rootIndex(), JSON.stringify(all));
}
const publishedIds = new Map<string, string>();
const revisions = new Map<string, number>();
const remembered = new Map<string, Map<string, string>>();
const rememberedBinary = new Map<string, Map<string, Buffer>>();
let publicOrigin = (process.env.ORVYN_PUBLIC_ORIGIN || "").replace(/\/$/, "");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".php": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
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

/** Active preview responses must not be cached across file writes. */
export const PREVIEW_CACHE_CONTROL = "no-store";

/**
 * Root-absolute project URLs ("/styles.css", url(/img/hero.svg)) point at the
 * site's own root when it is served under a path prefix. Protocol-relative
 * ("//cdn…"), absolute, data: and already-prefixed URLs are left alone.
 */
export function rebaseRootUrls(text: string, prefix: string, kind: "html" | "css"): string {
  const root = prefix.replace(/\/+$/, "");
  const fix = (url: string) => (url.startsWith("/") && !url.startsWith("//") && !url.startsWith(root + "/") ? `${root}${url}` : url);
  const css = (t: string) => t.replace(/url\(\s*(["']?)(\/[^"')\s]*)\1\s*\)/gi, (_m, q: string, url: string) => `url(${q}${fix(url)}${q})`);
  if (kind === "css") return css(text);
  return css(
    text
      .replace(/(\s(?:href|src|poster|action|data-src)\s*=\s*)(["'])(\/[^"']*)\2/gi, (_m, attr: string, q: string, url: string) => `${attr}${q}${fix(url)}${q}`)
      .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, attr: string, q: string, list: string) => `${attr}${q}${list.split(",").map((part) => part.trim().replace(/^(\S+)/, (u) => fix(u))).join(", ")}${q}`)
  );
}

const SITE_ASSET = /\.(html?|css|js|mjs|svg|png|jpe?g|webp|json|php)$/i;

export function isSiteAssetPath(filePath: string): boolean {
  return SITE_ASSET.test(filePath.replace(/\\/g, "/"));
}

/** Keep a file the agent just wrote, keyed by run, so the preview does not depend on the project disk. */
export function rememberSiteFile(runId: string, relPath: string, content: string): void {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) return;
  const bag = remembered.get(runId) ?? new Map<string, string>();
  bag.set(rel, content);
  remembered.set(runId, bag);
}

/** A verified project image used by the page must be present in the published preview. */
export function rememberSiteBinary(runId: string, relPath: string, bytes: Buffer): void {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || !bytes.length) return;
  const bag = rememberedBinary.get(runId) ?? new Map<string, Buffer>();
  bag.set(rel, Buffer.from(bytes));
  rememberedBinary.set(runId, bag);
}

/** The page as remembered (not composed), for finding the files it links. */
export function composeSiteDocumentSource(runId: string, pageKey: string): string | null {
  return remembered.get(runId)?.get(pageKey) ?? null;
}

/**
 * A follow-up in the same chat starts with the site the earlier run built:
 * its remembered pages, styles, scripts and images (from memory, or from
 * that run's published preview folder after a restart). Files this run
 * already has are kept. Returns the files inherited.
 */
export function inheritSiteFiles(runId: string, fromRunIds: string[], siteKey?: string): string[] {
  const inherited: string[] = [];
  const bag = remembered.get(runId) ?? new Map<string, string>();
  const bin = rememberedBinary.get(runId) ?? new Map<string, Buffer>();
  const candidates = [...[...fromRunIds].reverse(), ...(siteKey ? [`site-${createHash("sha256").update(siteKey).digest("hex").slice(0, 16)}`] : [])];
  for (const from of candidates) {
    if (!from || from === runId) continue;
    const prior = remembered.get(from);
    const priorBin = rememberedBinary.get(from);
    if (prior?.size) {
      for (const [rel, body] of prior) if (!bag.has(rel)) { bag.set(rel, body); inherited.push(rel); }
      for (const [rel, bytes] of priorBin ?? []) if (!bin.has(rel)) { bin.set(rel, bytes); inherited.push(rel); }
    } else {
      const dir = join(previewBase(), from);
      if (!existsSync(dir)) continue;
      const walk = (d: string, rel: string, depth: number) => {
        if (depth > 4) return;
        let entries: import("fs").Dirent[] = [];
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const abs = join(d, e.name);
          if (e.isDirectory()) { walk(abs, childRel, depth + 1); continue; }
          if (!e.isFile() || !SITE_ASSET.test(e.name) && !/\.(gif|ico|woff2?)$/i.test(e.name)) continue;
          if (bag.has(childRel) || bin.has(childRel)) continue;
          try {
            if (/\.(png|jpe?g|webp|gif|ico|woff2?)$/i.test(e.name)) bin.set(childRel, readFileSync(abs));
            else bag.set(childRel, readFileSync(abs, "utf8"));
            inherited.push(childRel);
          } catch { /* unreadable */ }
        }
      };
      walk(dir, "", 0);
    }
    if (inherited.length) break; // the most recent run that had a site
  }
  if (bag.size) remembered.set(runId, bag);
  if (bin.size) rememberedBinary.set(runId, bin);
  return inherited;
}

/** A site file already remembered for this run (ORION wrote or read it). */
export function hasSiteFile(runId: string, relPath: string): boolean {
  const key = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return (remembered.get(runId)?.has(key) ?? false) || (rememberedBinary.get(runId)?.has(key) ?? false);
}

/** Assets served as bytes (read from the project as base64). */
export const BINARY_ASSET = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm)$/i;
const ASSET = /\.(css|m?js|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|json|webmanifest)$/i;
/** Linked files the project does not have (a real 404): not fetched again, reported by the check. */
const unreadable = new Map<string, Set<string>>();
export function noteUnreadable(runId: string, rel: string): void {
  const set = unreadable.get(runId) ?? new Set<string>();
  set.add(rel);
  unreadable.set(runId, set);
}
export function unreadableAssets(runId: string): string[] {
  return [...(unreadable.get(runId) ?? [])];
}

/** "../img/a.png" from "css/site.css" → "img/a.png"; null when it leaves the site. */
function resolveRef(fromDir: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0]!.trim();
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean) || /^(data|blob|mailto|tel|javascript):/i.test(clean)) return null;
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${fromDir}${clean}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  const joined = out.join("/");
  try { return decodeURIComponent(joined); } catch { return joined; }
}

/** Every local file the page needs to render: stylesheets, scripts, images, fonts, CSS url()s. */
export function siteAssetRefs(runId: string): string[] {
  const bag = remembered.get(runId);
  if (!bag) return [];
  const pageKey = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  if (!pageKey) return [];
  const pageDir = pageKey.includes("/") ? pageKey.slice(0, pageKey.lastIndexOf("/") + 1) : "";
  const html = composeSiteDocumentSource(runId, pageKey) ?? bag.get(pageKey) ?? "";
  const refs = new Set<string>();
  const add = (dir: string, ref: string) => { const r = resolveRef(dir, ref); if (r && ASSET.test(r)) refs.add(r); };
  for (const m of html.matchAll(/<(?:link|script|img|source|video|audio|image|use)\b[^>]*?\s(?:href|src|poster|xlink:href)\s*=\s*["']([^"']+)["']/gi)) add(pageDir, m[1]!);
  for (const m of html.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1]!.split(",")) add(pageDir, part.trim().split(/\s+/)[0] ?? "");
  const cssUrls = (text: string, dir: string) => { for (const m of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) add(dir, m[1]!); for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(dir, m[1]!); };
  cssUrls(html, pageDir);
  for (const [name, text] of bag) if (/\.css$/i.test(name)) cssUrls(text, name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "");
  const skip = unreadable.get(runId);
  return [...refs].filter((r) => !skip?.has(r));
}

export function rememberedSiteFiles(runId: string): string[] {
  return [...(remembered.get(runId)?.keys() ?? [])];
}

export function forgetSiteFile(runId: string, relPath: string): void {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  remembered.get(runId)?.delete(rel);
}

export function moveSiteFile(runId: string, fromPath: string, toPath: string): void {
  const from = fromPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const to = toPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const bag = remembered.get(runId);
  if (!bag || !from || !to || to.includes("..")) return;
  const body = bag.get(from);
  if (body === undefined) return;
  bag.delete(from);
  bag.set(to, body);
}

/**
 * edit_file changes a file in place (on the user's computer for local runs):
 * apply the same replacement to the remembered copy, so the preview shows the
 * edited stylesheet instead of the old one. Returns false when the file is
 * not remembered or the text is not found.
 */
export function applySiteEdit(runId: string, relPath: string, oldText: string, newText: string, replaceAll = false): boolean {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const bag = remembered.get(runId);
  const current = bag?.get(rel);
  if (!bag || current === undefined || !oldText || !current.includes(oldText)) return false;
  bag.set(rel, replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, () => newText));
  return true;
}

/**
 * The preview root is the folder that contains index.html, so a root-relative
 * "/styles.css" is the file next to that page, not the API host root.
 */
function relativizeRootRefs(html: string, _pageKey: string, _bag: Map<string, string>): string {
  return html.replace(/(<(?:link|script|img|source)\b[^>]*?\s(?:href|src)\s*=\s*["'])\/(?!\/)([^"'?#]+)/gi, (m, lead: string, ref: string) => {
    if (/^(?:api|artifacts)\//i.test(ref)) return m;
    return `${lead}${ref}`;
  });
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
  let html = relativizeRootRefs(bag.get(pageKey) ?? "", pageKey, bag);
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

export interface PublishedSite {
  id: string;
  url: string;
  files: string[];
  revision: number;
  changedFiles: string[];
  /** True only the first time this run gets a preview URL. */
  first: boolean;
  /** True when nothing new was written, so the caller should not emit again. */
  unchanged: boolean;
}

/** One address per project: every run of a chat updates the same preview URL (it survives restarts). */
export function stablePreviewId(siteKey: string): string {
  const h = createHash("sha256").update(`orvyn-preview:${siteKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Stylesheets and scripts the page links that this run does not have (yet). */
export function missingLinkedAssets(runId: string): string[] {
  const bag = remembered.get(runId);
  const pageKey = bag ? [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name)) : undefined;
  if (!bag || !pageKey) return [];
  const pageDir = pageKey.includes("/") ? pageKey.slice(0, pageKey.lastIndexOf("/") + 1) : "";
  const html = bag.get(pageKey) ?? "";
  const refs = [...html.matchAll(/<(?:link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*|script\b[^>]*)\s(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1]!.split(/[?#]/)[0]!)
    .filter((ref) => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith("data:") && /\.(css|m?js)$/i.test(ref) && !ref.includes(".."))
    .map((ref) => (ref.startsWith("/") ? ref.slice(1) : `${pageDir}${ref.replace(/^\.\//, "")}`));
  const skip = unreadable.get(runId);
  return [...new Set(refs)].filter((ref) => !bag.has(ref) && !skip?.has(ref));
}

/** Write the remembered pages to one stable folder. Later files update that same URL. */
export function publishRememberedSite(runId: string, changedFiles: string[] = [], opts: { siteKey?: string; sourceRoot?: string } = {}): PublishedSite | null {
  const bag = remembered.get(runId);
  if (!bag || ![...bag.keys()].some((name) => /(^|\/)index\.(html|php)$/i.test(name))) return null;
  const existingId = publishedIds.get(runId);
  const composed = composeSiteDocument(runId);
  const pageKey = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  const dir = join(previewBase(), opts.siteKey ? `site-${createHash("sha256").update(opts.siteKey).digest("hex").slice(0, 16)}` : runId);
  for (const [rel, content] of bag) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, rel === pageKey && composed ? composed : content);
  }
  for (const [rel, bytes] of rememberedBinary.get(runId) ?? []) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, bytes);
  }
  const pageDir = pageKey && pageKey.includes("/") ? pageKey.slice(0, pageKey.lastIndexOf("/")) : "";
  const root = pageDir ? join(dir, pageDir) : dir;
  const id = existingId ?? (opts.siteKey ? stablePreviewId(opts.siteKey) : randomUUID());
  const bump = !existingId || changedFiles.length > 0;
  const revision = bump ? (revisions.get(runId) ?? 0) + 1 : (revisions.get(runId) ?? 1);
  publishedIds.set(runId, id);
  revisions.set(runId, revision);
  const sourceRoot = opts.sourceRoot && existsSync(opts.sourceRoot)
    ? (pageDir ? join(opts.sourceRoot, pageDir) : opts.sourceRoot)
    : undefined;
  saveRoot(id, root, sourceRoot);
  return {
    id,
    url: previewUrl(id),
    files: [...bag.keys(), ...(rememberedBinary.get(runId)?.keys() ?? [])],
    revision,
    changedFiles,
    first: !existingId,
    unchanged: Boolean(existingId) && changedFiles.length === 0,
  };
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
  // A linked stylesheet, script or image the preview folder lacks is served
  // from the project itself, so the page never renders unstyled.
  const source = sources.get(id);
  if ((!existsSync(abs) || !statSync(abs).isFile()) && source && ext && ext !== ".html" && TYPES[ext]) {
    const fromSource = join(source, safe);
    const sourcePrefix = source.endsWith(sep) ? source : source + sep;
    if (fromSource.startsWith(sourcePrefix) && existsSync(fromSource) && statSync(fromSource).isFile()) {
      return { body: readFileSync(fromSource), contentType: TYPES[ext]! };
    }
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    if ((!ext || ext === ".html") && existsSync(index)) return { body: readFileSync(index), contentType: TYPES[".html"] };
    return undefined;
  }
  const contentType = TYPES[ext];
  if (!contentType) return undefined;
  return { body: readFileSync(abs), contentType };
}
