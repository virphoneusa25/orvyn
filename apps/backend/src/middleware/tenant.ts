// apps/backend/src/middleware/tenant.ts
import { Request, Response, NextFunction } from "express";
import { Tenant, tenantManager } from "../tenancy/TenantManager";
import { authService } from "../auth/AuthService";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
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
export async function resolveTenant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const key = extractKey(req);

    if (!key) {
      // No key: only allowed when no API keys are registered (pure local dev).
      if (tenantManager.hasRegisteredKeys()) {
        res.status(401).json({ error: "Unauthorized — missing API key" });
        return;
      }
      req.tenant = await tenantManager.ensureLocalDefault();
      next();
      return;
    }

    // Session tokens (per-user accounts) take precedence over shared API keys.
    const user = authService.verify(key);
    if (user) {
      const tenant = await tenantManager.ensureUserTenant(user.id, user.email);
      tenant.usage.requests++;
      req.tenant = tenant;
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
  } catch (err: any) {
    // Express 4 does not automatically route rejected async middleware
    // Promises into the error pipeline. Fail closed and return a truthful
    // storage/service-unavailable response instead of leaving the request hung.
    console.error(
      `[tenant] failed to hydrate tenant persistence: ${err?.message ?? err}`
    );
    res.status(503).json({
      error: "Tenant storage is temporarily unavailable.",
    });
  }
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

export async function resolveTenantFromToken(token: string | null): Promise<Tenant | undefined> {
  if (!token) return undefined;
  const user = authService.verify(token);
  if (user) return tenantManager.ensureUserTenant(user.id, user.email);
  return tenantManager.resolveByApiKey(token);
}
