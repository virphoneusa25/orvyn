// Serves a directory the agent already wrote. This module does not author pages.

import { randomUUID } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { join, normalize, extname, sep, isAbsolute } from "path";

const roots = new Map<string, string>();
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
