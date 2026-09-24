// Serves a directory the agent already wrote. This module does not author pages.

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, normalize, extname, sep, isAbsolute } from "path";

const roots = new Map<string, string>();
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

/** One document: the page plus every stylesheet and script the agent wrote. */
export function composeSiteDocument(runId: string): string | null {
  const bag = remembered.get(runId);
  if (!bag) return null;
  const pageKey = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  if (!pageKey) return null;
  let html = bag.get(pageKey) ?? "";
  const css = [...bag.entries()].filter(([name]) => name.endsWith(".css")).map(([, body]) => body).join("\n");
  const js = [...bag.entries()].filter(([name]) => name.endsWith(".js")).map(([, body]) => body).join("\n");
  if (css && !html.includes(css.slice(0, 40))) {
    const style = `<style>\n${css}\n</style>`;
    html = html.includes("</head>") ? html.replace("</head>", `${style}\n</head>`) : style + html;
  }
  if (js && !html.includes(js.slice(0, 40))) {
    const script = `<script>\n${js}\n</script>`;
    html = html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : html + script;
  }
  return html;
}

/** Write the remembered pages to a temp folder and publish them. */
export function publishRememberedSite(runId: string): { id: string; url: string; files: string[] } | null {
  const bag = remembered.get(runId);
  if (!bag || ![...bag.keys()].some((name) => /(^|\/)index\.(html|php)$/i.test(name))) return null;
  const dir = join(tmpdir(), "orvyn-preview", runId);
  for (const [rel, content] of bag) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const pageDir = [...bag.keys()].find((name) => /(^|\/)index\.html$/i.test(name));
  const root = pageDir && pageDir.includes("/") ? join(dir, pageDir.slice(0, pageDir.lastIndexOf("/"))) : dir;
  const published = publishAgentSite(root);
  if (!published) return null;
  return { ...published, files: [...bag.keys()] };
}

/** Publish a folder the agent wrote. Returns a URL only when that folder has a page. */
export function publishAgentSite(dir: string): { id: string; url: string } | null {
  if (!dir || !existsSync(dir)) return null;
  const page = ["index.html", "index.php"].find((name) => existsSync(join(dir, name)));
  if (!page) return null;
  const id = randomUUID();
  roots.set(id, dir);
  return { id, url: previewUrl(id) };
}

export function readPublishedFile(id: string, rel: string): { body: Buffer; contentType: string } | undefined {
  const root = roots.get(id);
  if (!root) return undefined;
  const safe = normalize(rel || "index.html").replace(/^(\.\.(\/|\\|$))+/, "");
  if (!safe || safe.startsWith("..") || safe.includes("\0") || isAbsolute(safe)) return undefined;
  const abs = join(root, safe === "." ? "index.html" : safe);
  const contentType = TYPES[extname(abs).toLowerCase()];
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (!contentType || !abs.startsWith(rootPrefix) || !existsSync(abs) || !statSync(abs).isFile()) return undefined;
  return { body: readFileSync(abs), contentType };
}
