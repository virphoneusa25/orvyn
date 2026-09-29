// apps/backend/src/middleware/customerRedaction.ts
//
// On ORVYN Cloud nothing a customer receives names ORVYN's model vendors:
// JSON responses, the run event stream (SSE) and the chat socket pass
// through redactForCustomer at the edge. Server logs keep the real names
// for operations; only what leaves for a customer is changed.

import type { NextFunction, Request, Response } from "express";
import { customerCatalogEnabled, redactForCustomer } from "../models/customerCatalog";
import type { Tenant } from "../tenancy/TenantManager";

export function platformModelIds(tenant: Pick<Tenant, "modelService">): Set<string> {
  const ms = tenant.modelService;
  return new Set(ms.registry.list().map((p) => p.config.id).filter((id) => !ms.isUserModel(id)));
}

export function customerRedaction(req: Request, res: Response, next: NextFunction): void {
  const tenant = req.tenant as Tenant | undefined;
  if (!customerCatalogEnabled() || !tenant) return next();
  let ids: Set<string> | null = null;
  const idsOf = () => (ids ??= platformModelIds(tenant));
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(redactForCustomer(body, idsOf()))) as Response["json"];
  const write = res.write.bind(res) as (chunk: any, ...rest: any[]) => boolean;
  res.write = ((chunk: any, ...rest: any[]) => {
    if (typeof chunk === "string" && chunk.startsWith("data: ") && (res.getHeader("Content-Type") ?? "").toString().includes("event-stream")) {
      try {
        const payload = JSON.parse(chunk.slice(6).trim());
        return write(`data: ${JSON.stringify(redactForCustomer(payload, idsOf()))}\n\n`, ...rest);
      } catch { /* not JSON: pass through */ }
    }
    return write(chunk, ...rest);
  }) as Response["write"];
  next();
}

/** For the chat WebSocket: redact one outgoing chunk. */
export function redactChunk<T>(tenant: Pick<Tenant, "modelService">, chunk: T): T {
  return customerCatalogEnabled() ? redactForCustomer(chunk, platformModelIds(tenant)) : chunk;
}
