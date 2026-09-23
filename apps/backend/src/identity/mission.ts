export interface MissionIdentity {
  tenantId: string;
  organizationId: string;
  userId: string;
  projectId: string | null;
  runId: string;
}

export const DEFAULT_MAX_CONCURRENT_PER_TENANT = 2;

export function maxConcurrentPerTenant(): number {
  const n = Number(process.env.ORVYN_MAX_CONCURRENT_PER_TENANT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT_PER_TENANT;
}

/** Path segment for tenant/run folders. Rejects traversal and reserved names. */
export function sanitizeMissionSegment(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) throw Object.assign(new Error("mission identity required"), { status: 400 });
  if (value.includes("\0") || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw Object.assign(new Error("invalid mission path segment"), { status: 400 });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw Object.assign(new Error("invalid mission path segment"), { status: 400 });
  }
  return value;
}

export function missionWorkspacePath(root: string, tenantId: string, runId: string): string {
  const tenant = sanitizeMissionSegment(tenantId);
  const run = sanitizeMissionSegment(runId);
  const base = root.replace(/[/\\]+$/, "");
  return `${base}/${tenant}/${run}`;
}

export function assertTrustedMission(identity: Partial<MissionIdentity> | null | undefined): MissionIdentity {
  const tenantId = String(identity?.tenantId ?? "").trim();
  const organizationId = String(identity?.organizationId ?? "").trim();
  const userId = String(identity?.userId ?? "").trim();
  const runId = String(identity?.runId ?? "").trim();
  if (!tenantId || !organizationId || !userId || !runId) {
    throw Object.assign(new Error("mission identity is assigned by the control plane"), { status: 400 });
  }
  sanitizeMissionSegment(tenantId);
  sanitizeMissionSegment(runId);
  return {
    tenantId,
    organizationId,
    userId,
    projectId: identity?.projectId ? String(identity.projectId) : null,
    runId,
  };
}

export interface FairJob {
  tenantId: string;
  createdAt: number;
  assignedTo?: string;
}

/** Oldest unassigned job whose tenant is under the concurrent cap. */
export function pickFairJob<T extends FairJob>(
  jobs: T[],
  activeByTenant: Map<string, number>,
  cap = maxConcurrentPerTenant()
): T | undefined {
  const waiting = jobs.filter((j) => !j.assignedTo).sort((a, b) => a.createdAt - b.createdAt);
  for (const job of waiting) {
    const used = activeByTenant.get(job.tenantId) ?? 0;
    if (used < cap) return job;
  }
  return undefined;
}

export function countActiveByTenant<T extends { tenantId?: string; assignedTo?: string }>(jobs: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!job.assignedTo || !job.tenantId) continue;
    counts.set(job.tenantId, (counts.get(job.tenantId) ?? 0) + 1);
  }
  return counts;
}
