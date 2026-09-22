// Enterprise MCP policy: Open / Verified Only / Allowlist Only, blocklist,
// admin tool deny (hard deny beats Full Access), org-approved catalog.

export type PolicyMode = "open" | "verified-only" | "allowlist-only";

export interface McpEnterprisePolicy {
  mode: PolicyMode;
  allowlist: string[];
  blocklist: string[];
  blockedPackages: string[];
  blockedPublishers: string[];
  blockedTools: string[];
  blockedSources: string[];
  requireApprovalForInstall: boolean;
  orgApproved: string[];
}

export const DEFAULT_POLICY: McpEnterprisePolicy = {
  mode: "open",
  allowlist: [],
  blocklist: [],
  blockedPackages: [],
  blockedPublishers: [],
  blockedTools: [],
  blockedSources: [],
  requireApprovalForInstall: false,
  orgApproved: [],
};

const POLICY_KEY = "mcp.enterprise.policy.v1";

export function readPolicy(store: { getSetting(k: string): unknown }): McpEnterprisePolicy {
  try {
    const raw = store.getSetting(POLICY_KEY);
    if (!raw) return { ...DEFAULT_POLICY };
    return { ...DEFAULT_POLICY, ...(JSON.parse(String(raw)) as Partial<McpEnterprisePolicy>) };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function writePolicy(store: { setSetting(k: string, v: string): void }, policy: McpEnterprisePolicy): void {
  store.setSetting(POLICY_KEY, JSON.stringify(policy));
}

export function denyStartReason(
  policy: McpEnterprisePolicy,
  server: {
    id?: string;
    canonicalId?: string;
    marketplaceId?: string;
    packageIdentifier?: string;
    publisher?: string;
    sourceProviders?: string[];
    trustLevel?: string;
  }
): string | null {
  const ids = [server.canonicalId, server.marketplaceId, server.id].filter(Boolean).map(String);
  if (ids.some((id) => policy.blocklist.includes(id))) return `Blocked by policy (${ids[0]})`;
  if (server.packageIdentifier && policy.blockedPackages.includes(server.packageIdentifier)) {
    return `Package ${server.packageIdentifier} is blocked`;
  }
  if (server.publisher && policy.blockedPublishers.includes(server.publisher)) {
    return `Publisher ${server.publisher} is blocked`;
  }
  for (const src of server.sourceProviders ?? []) {
    if (policy.blockedSources.includes(src)) return `Registry source ${src} is blocked`;
  }
  if (policy.mode === "verified-only" && server.trustLevel !== "verified" && !ids.some((id) => policy.orgApproved.includes(id))) {
    return "Policy is Verified Only — this server is not ORVYN Verified or organization-approved";
  }
  if (policy.mode === "allowlist-only" && !ids.some((id) => policy.allowlist.includes(id) || policy.orgApproved.includes(id))) {
    return "Policy is Allowlist Only — this server is not on the organization allowlist";
  }
  return null;
}

export function adminToolDenied(policy: McpEnterprisePolicy, toolName: string): boolean {
  const original = toolName.replace(/^mcp\.[^.]+\./, "");
  return policy.blockedTools.includes(toolName) || policy.blockedTools.includes(original);
}

export function isOrgApproved(policy: McpEnterprisePolicy, canonicalId?: string): boolean {
  return Boolean(canonicalId && policy.orgApproved.includes(canonicalId));
}
