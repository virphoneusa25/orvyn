// apps/backend/src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";

// Phase 1 auth: a single shared API key via VIRIDE_API_KEY. This is the
// minimum required before exposing the backend past localhost — NOT a
// substitute for the real multi-user auth/RBAC in master spec section 22,
// which is Phase 7. Do not deploy this backend to a public IP without
// setting VIRIDE_API_KEY (or putting it behind a VPN/SSH tunnel instead).
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const requiredKey = process.env.VIRIDE_API_KEY;

  // No key configured: allow through, but this should only ever happen on
  // localhost during local development. server startup logs a loud warning.
  if (!requiredKey) {
    next();
    return;
  }

  const header = req.header("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.header("x-api-key");

  if (provided !== requiredKey) {
    res.status(401).json({ error: "Unauthorized — missing or invalid API key" });
    return;
  }
  next();
}

export function wsAuthorized(req: { url?: string; headers: Record<string, unknown> }): boolean {
  const requiredKey = process.env.VIRIDE_API_KEY;
  if (!requiredKey) return true;
  const url = new URL(req.url ?? "", "http://internal");
  const token = url.searchParams.get("token");
  return token === requiredKey;
}
