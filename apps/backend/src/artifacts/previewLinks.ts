// apps/backend/src/artifacts/previewLinks.ts
//
// A short-lived link that shows ONE stored file in the portal's preview frame.
// HTML and PDF previews need a real URL: a blob: or srcdoc frame inherits the
// portal's own strict CSP (its scripts would never run). The link is a
// capability for that single file only — never a session — expires in five
// minutes, and the file is served sandboxed (an opaque origin).

import { randomBytes } from "node:crypto";

const TTL_MS = 5 * 60_000;
const links = new Map<string, { tenantId: string; artifactId: string; expiresAt: number }>();

export function createPreviewLink(tenantId: string, artifactId: string, now = Date.now()): string {
  for (const [k, v] of links) if (v.expiresAt <= now) links.delete(k);
  const token = `pvw_${randomBytes(24).toString("base64url")}`;
  links.set(token, { tenantId, artifactId, expiresAt: now + TTL_MS });
  return token;
}

export function resolvePreviewLink(token: string, now = Date.now()): { tenantId: string; artifactId: string } | null {
  const v = links.get(token);
  if (!v) return null;
  if (v.expiresAt <= now) { links.delete(token); return null; }
  return { tenantId: v.tenantId, artifactId: v.artifactId };
}
