/** Org / user policy for Auto model fallback. Never silently overrides a pinned model. */
export interface ComputerUsePolicy {
  fallbackDisabled: boolean;
  allowlist: string[];
}

export function readComputerUsePolicy(env: NodeJS.ProcessEnv = process.env): ComputerUsePolicy {
  const fallbackDisabled =
    env.ORVYN_DISABLE_MODEL_FALLBACK === "1" ||
    env.ORVYN_DISABLE_MODEL_FALLBACK === "true" ||
    env.ORVYN_ORG_DISABLE_MODEL_FALLBACK === "1";
  const raw = env.ORVYN_MODEL_ALLOWLIST ?? env.ORVYN_ORG_MODEL_ALLOWLIST ?? "";
  const allowlist = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { fallbackDisabled, allowlist };
}

export function allowlistAllows(allowlist: string[], modelId: string, provider: string): boolean {
  if (!allowlist.length) return true;
  return allowlist.includes(modelId) || allowlist.includes(provider);
}
