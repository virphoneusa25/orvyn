// Decides which tenant a worker route may touch.
// User sessions never choose another tenant. The control-plane credential
// (the worker's API key) may only address a tenant that already exists,
// and event writes follow the tenant recorded on the job — not a body field.

export interface TenantDecision {
  ok: true;
  tenantId: string;
}

export interface TenantDenial {
  ok: false;
  status: number;
  error: string;
}

export type TenantResult = TenantDecision | TenantDenial;

export function isUserTenant(id: string): boolean {
  return id.startsWith("user_");
}

/** Register, poll, and tool RPC are worker credentials only. */
export function assertWorkerCredential(callerId: string): TenantResult {
  if (!callerId) return { ok: false, status: 401, error: "Unauthorized" };
  if (isUserTenant(callerId)) {
    return { ok: false, status: 403, error: "Worker credentials required" };
  }
  return { ok: true, tenantId: callerId };
}

export function resolveWorkerTenant(opts: {
  callerId: string;
  requestedTenantId?: string;
  tenantExists: (id: string) => boolean;
}): TenantResult {
  const requested = opts.requestedTenantId?.trim() || undefined;
  if (!opts.callerId) return { ok: false, status: 401, error: "Unauthorized" };

  if (isUserTenant(opts.callerId)) {
    if (requested && requested !== opts.callerId) {
      return { ok: false, status: 403, error: "Cannot address another tenant" };
    }
    return { ok: true, tenantId: opts.callerId };
  }

  const target = requested && requested !== opts.callerId ? requested : opts.callerId;
  if (!opts.tenantExists(target)) {
    return { ok: false, status: 403, error: "Unknown tenant" };
  }
  return { ok: true, tenantId: target };
}

/**
 * Event and cancel writes. A job's recorded tenant wins over the request
 * body so a worker cannot retarget the event after the job was queued.
 */
export function resolveEventTenant(opts: {
  callerId: string;
  jobTenantId?: string;
  requestedTenantId?: string;
  tenantExists: (id: string) => boolean;
}): TenantResult {
  if (opts.jobTenantId) {
    // The job's recorded tenant wins. A user session may touch only its own job.
    if (isUserTenant(opts.callerId) && opts.callerId !== opts.jobTenantId) {
      return { ok: false, status: 403, error: "Cannot address another tenant" };
    }
    if (!opts.tenantExists(opts.jobTenantId)) {
      return { ok: false, status: 403, error: "Unknown tenant" };
    }
    return { ok: true, tenantId: opts.jobTenantId };
  }
  return resolveWorkerTenant({
    callerId: opts.callerId,
    requestedTenantId: opts.requestedTenantId,
    tenantExists: opts.tenantExists,
  });
}
