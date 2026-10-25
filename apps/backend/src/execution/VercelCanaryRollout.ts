// apps/backend/src/execution/VercelCanaryRollout.ts
//
// Tenant-scoped & administrator-allowlisted canary rollout for Vercel Cloud execution.
// Ensures existing customers remain on their current execution providers without
// unexpected changes, while designated administrator canary accounts route to Vercel.

export const VERCEL_CANARY_FLAG = "vercel_cloud_execution";

export interface CanaryContext {
  tenantId?: string;
  userId?: string;
  organizationId?: string;
  projectId?: string | null;
  isStaff?: boolean;
}

export interface CanaryDecision {
  provider: "vercel" | "ovh";
  location: "VERCEL_CLOUD" | "OVH_WORKER";
  eligible: boolean;
  reason: string;
}

export interface DynamicCanaryStore {
  flag?(scope: "org" | "project", scopeId: string, flag: string): boolean | Promise<boolean>;
}

// In-memory dynamic allowlists updated via Admin API
const dynamicAllowedTenants = new Set<string>();
const dynamicAllowedUsers = new Set<string>();
const dynamicAllowedOrgs = new Set<string>();
let emergencyDisableSwitch = false;

export function setEmergencyDisableVercel(disabled: boolean): void {
  emergencyDisableSwitch = disabled;
}

export function isEmergencyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (emergencyDisableSwitch) return true;
  if (env.ORVYN_CLOUD_EMERGENCY_DISABLE_VERCEL === "true") return true;
  if (env.VERCEL_CLOUD_ENABLED === "false") return true;
  return false;
}

export function addCanaryTenant(tenantId: string): void {
  if (tenantId) dynamicAllowedTenants.add(tenantId.trim());
}

export function removeCanaryTenant(tenantId: string): void {
  dynamicAllowedTenants.delete(tenantId.trim());
}

export function addCanaryUser(userId: string): void {
  if (userId) dynamicAllowedUsers.add(userId.trim());
}

export function removeCanaryUser(userId: string): void {
  dynamicAllowedUsers.delete(userId.trim());
}

export function listDynamicCanaries(): { tenants: string[]; users: string[]; orgs: string[]; emergencyDisabled: boolean } {
  return {
    tenants: Array.from(dynamicAllowedTenants),
    users: Array.from(dynamicAllowedUsers),
    orgs: Array.from(dynamicAllowedOrgs),
    emergencyDisabled: isEmergencyDisabled(),
  };
}

function parseList(val: string | undefined): string[] {
  if (!val) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolves whether the current run should execute on Vercel Sandbox or legacy OVH worker.
 * 
 * Rules:
 * 1. Global emergency disable switch immediately routes everyone to OVH worker.
 * 2. If canary rollout is active, only explicitly allowlisted administrator accounts
 *    route to Vercel Sandbox.
 * 3. All other customer runs remain on their original execution provider (OVH worker).
 * 4. Never silently falls back between providers during execution.
 */
export async function resolveCloudExecutionProvider(
  context: CanaryContext = {},
  env: NodeJS.ProcessEnv = process.env,
  store?: DynamicCanaryStore
): Promise<CanaryDecision> {
  // 1. Emergency disable check
  if (isEmergencyDisabled(env)) {
    return {
      provider: "ovh",
      location: "OVH_WORKER",
      eligible: false,
      reason: "Vercel Cloud execution is globally disabled via emergency switch",
    };
  }

  const globalProvider = (env.ORVYN_CLOUD_EXECUTION_PROVIDER ?? "").trim().toLowerCase();
  const canaryRequired = env.VERCEL_CANARY_REQUIRED !== "false";

  // If global provider is vercel AND canary is not required, broad rollout is enabled
  if (globalProvider === "vercel" && !canaryRequired) {
    return {
      provider: "vercel",
      location: "VERCEL_CLOUD",
      eligible: true,
      reason: "Vercel Cloud broad rollout enabled (VERCEL_CANARY_REQUIRED=false)",
    };
  }

  // If global provider is ovh and canary is not explicitly allowed on OVH stack
  const allowCanary =
    globalProvider === "vercel" ||
    globalProvider === "canary" ||
    env.VERCEL_CANARY_ENABLED === "true" ||
    Boolean(env.VERCEL_CANARY_USERS || env.VERCEL_CANARY_TENANTS || env.VERCEL_CANARY_ORGS) ||
    dynamicAllowedUsers.size > 0 ||
    dynamicAllowedTenants.size > 0;

  if (!allowCanary) {
    return {
      provider: "ovh",
      location: "OVH_WORKER",
      eligible: false,
      reason: "Standard customer execution; legacy OVH worker default",
    };
  }

  // 2. Evaluate canary allowlist
  const envUsers = parseList(env.VERCEL_CANARY_USERS);
  const envTenants = parseList(env.VERCEL_CANARY_TENANTS);
  const envOrgs = parseList(env.VERCEL_CANARY_ORGS);

  const userId = context.userId?.trim();
  const tenantId = context.tenantId?.trim();
  const orgId = context.organizationId?.trim();
  const projectId = context.projectId?.trim();

  let matchedReason: string | null = null;

  if (userId && (envUsers.includes(userId) || dynamicAllowedUsers.has(userId))) {
    matchedReason = `user allowlist (${userId})`;
  } else if (tenantId && (envTenants.includes(tenantId) || dynamicAllowedTenants.has(tenantId))) {
    matchedReason = `tenant allowlist (${tenantId})`;
  } else if (orgId && (envOrgs.includes(orgId) || dynamicAllowedOrgs.has(orgId))) {
    matchedReason = `organization allowlist (${orgId})`;
  }

  // Check dynamic registry flag if present and not already matched
  if (!matchedReason && store?.flag) {
    if (orgId && (await store.flag("org", orgId, VERCEL_CANARY_FLAG))) {
      matchedReason = `organization registry flag (${orgId})`;
    } else if (projectId && (await store.flag("project", projectId, VERCEL_CANARY_FLAG))) {
      matchedReason = `project registry flag (${projectId})`;
    }
  }

  if (!matchedReason) {
    return {
      provider: "ovh",
      location: "OVH_WORKER",
      eligible: false,
      reason: "Non-canary customer account; routed to standard OVH worker",
    };
  }

  // 3. Admin-only check during canary phase (default true)
  const adminOnly = env.VERCEL_CANARY_ADMIN_ONLY !== "false";
  if (adminOnly && !context.isStaff) {
    return {
      provider: "ovh",
      location: "OVH_WORKER",
      eligible: false,
      reason: `Account matched ${matchedReason} but lacks verified administrator staff authorization`,
    };
  }

  return {
    provider: "vercel",
    location: "VERCEL_CLOUD",
    eligible: true,
    reason: `Canary administrator activated via ${matchedReason}`,
  };
}
