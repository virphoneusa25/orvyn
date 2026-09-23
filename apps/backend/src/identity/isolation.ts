import { bindTenantResource } from "../orgs/organization";

/** Client-supplied tenant/org ids are never authoritative. */
export function claimedTenantId(input: {
  body?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
  header?: (name: string) => string | undefined;
}): string | undefined {
  const body = input.body ?? {};
  const query = input.query ?? {};
  const header =
    input.header?.("x-tenant-id") ??
    input.header?.("X-Tenant-Id");
  const raw = body.tenantId ?? body.tenant_id ?? query.tenantId ?? query.tenant_id ?? header;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function rejectTenantOverride(authenticatedTenantId: string, claimed?: string): void {
  if (!claimed) return;
  if (claimed !== authenticatedTenantId) {
    throw Object.assign(new Error("tenantId is resolved from the session, not the client"), { status: 403 });
  }
}

export function scopedGet<T extends { tenantId?: string | null }>(
  resource: T | null | undefined,
  authenticatedTenantId: string
): T {
  if (!resource) {
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
  const resourceTenant = String(resource.tenantId ?? "");
  if (!resourceTenant || resourceTenant !== authenticatedTenantId) {
    bindTenantResource(authenticatedTenantId, resourceTenant || "__missing__");
  }
  return resource;
}

export function isolation404(): never {
  throw Object.assign(new Error("Not found"), { status: 404 });
}
