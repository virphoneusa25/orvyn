/** Billing is an abstraction. Stripe is not wired here. */

export interface UsageMeterSnapshot {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  modelRequests: number;
  toolRuntimeMs: number;
  cloudWorkerMs: number;
  sandboxMs: number;
  storageBytes: number;
  estimatedCostUsd: number;
}

export interface BillingProvider {
  name: string;
  meter(snapshot: UsageMeterSnapshot): Promise<{ ok: boolean; detail?: string }>;
}

export class NullBillingProvider implements BillingProvider {
  name = "none";
  async meter(_snapshot?: UsageMeterSnapshot): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "No payment provider configured. Usage is recorded; nothing is charged here." };
  }
}

export function estimateRunCost(input: {
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  cloudWorkerMs?: number;
}): { estimatedCost: number; executionCost: number } {
  const tokens = (input.promptTokens ?? 0) * 0.000002 + (input.completionTokens ?? 0) * 0.000008;
  const exec = ((input.cloudWorkerMs ?? 0) / 3_600_000) * 0.4;
  return { estimatedCost: Number((tokens + exec).toFixed(6)), executionCost: Number(exec.toFixed(6)) };
}
