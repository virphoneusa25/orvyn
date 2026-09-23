import type { ConnectionConfig } from "./connection";

export interface SessionPrincipal {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  organizationKind: "personal" | "company";
  tenantId: string;
  role: "owner" | "admin" | "member";
}

export interface SessionOrganization {
  id: string;
  name: string;
  kind: "personal" | "company";
  tenantId: string;
}

const TENANT_CACHE_KEYS = [
  "orvyn:chats",
  "orvyn:projects",
  "orvyn:artifacts",
  "orvyn:mcp-state",
  "orvyn:files",
  "orvyn:runs",
  "orvyn:current-org",
];

let principal: SessionPrincipal | null = null;
let organizations: SessionOrganization[] = [];

export function currentPrincipal(): SessionPrincipal | null {
  return principal;
}

export function currentOrganizations(): SessionOrganization[] {
  return organizations.slice();
}

export function setSession(next: SessionPrincipal | null, orgs: SessionOrganization[] = []): void {
  principal = next;
  organizations = orgs.slice();
}

export function clearTenantCaches(storage: Pick<Storage, "removeItem"> | null = typeof globalThis !== "undefined" ? globalThis.localStorage : null): void {
  if (!storage) return;
  for (const key of TENANT_CACHE_KEYS) {
    try { storage.removeItem(key); } catch { /* ignore */ }
  }
}

export function clearSession(storage?: Pick<Storage, "removeItem"> | null): void {
  principal = null;
  organizations = [];
  clearTenantCaches(storage);
}

export function applyAuthPayload(data: {
  principal?: SessionPrincipal | null;
  organizations?: SessionOrganization[];
  organization?: SessionOrganization;
}): SessionPrincipal | null {
  const orgs = data.organizations ?? (data.organization ? [data.organization] : []);
  setSession(data.principal ?? null, orgs);
  return principal;
}

export const ORVYN_STAGING_URL = "https://staging.orvyn.virphoneusa.com";

export function isStagingBackend(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("staging.") || host.includes("sslip.io");
  } catch {
    return false;
  }
}

export function sessionMatchesConfig(config: ConnectionConfig): boolean {
  if (!principal) return false;
  return Boolean(config.apiKey);
}
