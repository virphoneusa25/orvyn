import { staffStore } from "../auth/AsyncAccountStores";
// apps/backend/src/middleware/tenant.ts
import { Request, Response, NextFunction } from "express";
import { Tenant, tenantManager } from "../tenancy/TenantManager";

import { authService } from "../auth/AsyncAuthService";
import type { Principal } from "../identity/principal";
import { claimedTenantId, rejectTenantOverride } from "../identity/isolation";
import { creditLedger } from "../billing/AsyncFinancialStores";
import { planById } from "../billing/plans";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
      principal?: Principal;
    }
  }
}

/** Production cloud refuses the local default tenant. Local dev leaves this unset. */
export function cloudModeEnabled(): boolean {
  return process.env.ORVYN_CLOUD_MODE === "true";
}

export function unauthenticatedTenantAllowed(): boolean {
  return !cloudModeEnabled() && !tenantManager.hasRegisteredKeys();
}

function extractKey(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;
  const token = req.query?.token;
  return typeof token === "string" && token ? token : undefined;
}

// Resolves the caller's tenant and attaches it to req.tenant. Every route then
// reads its services off req.tenant instead of module globals, which is what
// actually enforces isolation.
export async function resolveTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (/\/ports\/[^/]+\/proxy$/.test(req.path) && typeof req.query.fwd === "string") {
    next();
    return;
  }
  const key = extractKey(req);

  if (!key) {
    // No key: only allowed for pure local dev. Cloud mode and any deployment
    // with registered API keys must not silently become the default tenant.
    if (!unauthenticatedTenantAllowed()) {
      res.status(401).json({ error: "Unauthorized — missing API key" });
      return;
    }
    req.tenant = tenantManager.ensureLocalDefault();
    next();
    return;
  }

  // Staff "View as customer": read-only, time-limited, and never a customer session.
  if (key.startsWith("orvview_")) {
    const view = (await staffStore().resolveViewAs(key));
    const as = view ? (await authService.principalFor(view.userId, view.organizationId)) : null;
    if (!view || !as) {
      res.status(401).json({ error: "This support view has ended.", code: "VIEW_AS_ENDED" });
      return;
    }
    const readOnly = ["GET", "HEAD", "OPTIONS"].includes(req.method) || (req.method === "POST" && /^\/artifacts\/[^/]+\/preview-link$/.test(req.path));
    if (!readOnly) {
      res.status(403).json({ error: "Support view is read-only.", code: "READ_ONLY_VIEW" });
      return;
    }
    req.tenant = tenantManager.ensureOrgTenant(as.principal);
    req.principal = as.principal;
    (req as Request & { viewAs?: unknown }).viewAs = view;
    next();
    return;
  }

  // A personal API key (Settings → API keys) acts as its owner in that
  // workspace — on plans that include API access, and never for account
  // management (req.apiKeyId marks it; the account routes refuse it).
  if (key.startsWith("orvkey_")) {
    const k = (await authService.verifyApiKey(key));
    if (!k) {
      res.status(401).json({ error: "Unauthorized — this API key is invalid or was revoked", code: "API_KEY_INVALID" });
      return;
    }
    if (!planById((await creditLedger.planOf(k.principal.tenantId)) ?? "free").features.apiAccess) {
      res.status(403).json({ error: "API access is included on the Business and Team plans.", code: "API_ACCESS_PLAN" });
      return;
    }
    req.tenant = tenantManager.ensureOrgTenant(k.principal);
    req.tenant.usage.requests++;
    req.principal = k.principal;
    (req as Request & { apiKeyId?: string }).apiKeyId = k.keyId;
    next();
    return;
  }

  // Session tokens (per-user accounts) take precedence over shared API keys.
  // Tenant identity comes from the session's organization — never the client.
  const session = (await authService.verifyPrincipal(key));
  if (session) {
    try {
      rejectTenantOverride(session.principal.tenantId, claimedTenantId({
        body: (req.body ?? {}) as Record<string, unknown>,
        query: (req.query ?? {}) as Record<string, unknown>,
        header: (name) => req.header(name),
      }));
    } catch (err: any) {
      res.status(err.status ?? 403).json({ error: err.message });
      return;
    }
    const tenant = tenantManager.ensureOrgTenant(session.principal);
    tenant.usage.requests++;
    req.tenant = tenant;
    req.principal = session.principal;
    next();
    return;
  }

  const tenant = tenantManager.resolveByApiKey(key);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized — invalid API key or session" });
    return;
  }

  tenant.usage.requests++;
  req.tenant = tenant;
  next();
}

// Routes call this instead of reaching for a global. Throws rather than
// silently falling back to shared state — a missing tenant is a bug, and
// failing loudly is safer than leaking another customer's data.
export function requireTenant(req: Request): Tenant {
  if (!req.tenant) {
    throw new Error("No tenant resolved for this request");
  }
  return req.tenant;
}

export function requirePrincipal(req: Request): Principal {
  if (!req.principal) {
    throw Object.assign(new Error("Authenticated session required"), { status: 401 });
  }
  return req.principal;
}

export async function resolveTenantFromToken(token: string | null): Promise<Tenant | undefined> {
  if (!token) return undefined;
  const session = (await authService.verifyPrincipal(token));
  if (session) return tenantManager.ensureOrgTenant(session.principal);
  return tenantManager.resolveByApiKey(token);
}

/**
 * WebSocket admission. In cloud mode (or when API keys exist) a missing or
 * invalid token is a hard reject — never the local default tenant.
 */
export async function authorizeSocket(token: string | null): Promise<{ ok: true; tenant: Tenant } | { ok: false; error: string }> {
  const tenant = (await resolveTenantFromToken(token));
  if (tenant) return { ok: true, tenant };
  if (!unauthenticatedTenantAllowed()) {
    return { ok: false, error: "Unauthorized — missing or invalid token" };
  }
  return { ok: true, tenant: tenantManager.ensureLocalDefault() };
}
