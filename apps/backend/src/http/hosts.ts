// apps/backend/src/http/hosts.ts
//
// ORVYN serves two web surfaces from one backend, by host:
//   ORVYN_APP_HOST   (e.g. app.kernelailabs.com)   — the customer portal
//   ORVYN_ADMIN_HOST (e.g. admin.kernelailabs.com) — the staff Admin Portal
// When ORVYN_ADMIN_HOST is set, the admin API and /admin pages answer only
// on that host. Unset (local development), everything is on one origin.

import type { Request } from "express";

const clean = (h: string | undefined | null) => String(h ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");

export function adminHost(env: NodeJS.ProcessEnv = process.env): string | null { return clean(env.ORVYN_ADMIN_HOST) || null; }
export function appHost(env: NodeJS.ProcessEnv = process.env): string | null { return clean(env.ORVYN_APP_HOST) || null; }

/** The host the browser used (behind the proxy: X-Forwarded-Host). */
export function requestHost(req: Request): string {
  return clean(String(req.header("x-forwarded-host") || req.get("host") || "").split(",")[0]);
}

export function onAdminHost(req: Request): boolean {
  const a = adminHost();
  return Boolean(a && requestHost(req) === a);
}

/** True when admin traffic must be refused on this request's host. */
export function adminHostMismatch(req: Request): boolean {
  const a = adminHost();
  return Boolean(a && requestHost(req) !== a);
}

export function originFor(req: Request, host: string): string {
  const proto = String(req.header("x-forwarded-proto") || req.protocol || "https").split(",")[0]!.trim();
  const port = String(req.get("host") ?? "").match(/:(\d+)$/)?.[1];
  // Keep a non-standard port (local testing); production is 443 behind the proxy.
  return `${proto}://${host}${port && !["80", "443"].includes(port) ? `:${port}` : ""}`;
}
