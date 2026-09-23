export interface AccountQuotas {
  tokenBudget: number;
  cloudMinutes: number;
  storageBytes: number;
  concurrentMissions: number;
  artifactStorageBytes: number;
}

export const DEFAULT_QUOTAS: AccountQuotas = {
  tokenBudget: Number(process.env.ORVYN_QUOTA_TOKENS_MONTH ?? 2_000_000),
  cloudMinutes: Number(process.env.ORVYN_QUOTA_CLOUD_MINUTES ?? 600),
  storageBytes: Number(process.env.ORVYN_QUOTA_STORAGE_BYTES ?? 2 * 1024 * 1024 * 1024),
  concurrentMissions: Number(process.env.ORVYN_QUOTA_CONCURRENT_MISSIONS ?? 2),
  artifactStorageBytes: Number(process.env.ORVYN_QUOTA_ARTIFACT_BYTES ?? 512 * 1024 * 1024),
};

export class EntitlementService {
  constructor(private quotas: AccountQuotas = DEFAULT_QUOTAS) {}

  check(used: Partial<AccountQuotas>): { ok: boolean; reason?: string } {
    if ((used.tokenBudget ?? 0) > this.quotas.tokenBudget) return { ok: false, reason: "Monthly token budget exceeded" };
    if ((used.cloudMinutes ?? 0) > this.quotas.cloudMinutes) return { ok: false, reason: "Cloud minute quota exceeded" };
    if ((used.storageBytes ?? 0) > this.quotas.storageBytes) return { ok: false, reason: "Storage quota exceeded" };
    if ((used.concurrentMissions ?? 0) > this.quotas.concurrentMissions) return { ok: false, reason: "Concurrent mission limit reached" };
    if ((used.artifactStorageBytes ?? 0) > this.quotas.artifactStorageBytes) return { ok: false, reason: "Artifact storage quota exceeded" };
    return { ok: true };
  }

  limits(): AccountQuotas {
    return { ...this.quotas };
  }
}
