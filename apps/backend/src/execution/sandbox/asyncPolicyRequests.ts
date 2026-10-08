// apps/backend/src/execution/sandbox/policyRequests.ts
//
// Network access for a mission sandbox is deny-by-default. The model can ASK
// for a reviewed template (request_network_access); only a person — the
// organization's owner/admin in the portal, or ORVYN staff — can approve it.
// Approved requests reach the worker with its next tool poll and are applied
// live. Credentials for an integration are brokered only for runs whose
// approved template needs them, and only for the run's own organization.

import type { PolicyRequest } from "./SandboxRegistry";
import type {SandboxOperations} from "./AsyncSandboxRegistry";
import { POLICY_TEMPLATES, templatesForPlan, type PolicyTemplateId } from "./selection";

/** Templates that carry an integration credential, and which one. */
export const TEMPLATE_CREDENTIALS: Partial<Record<PolicyTemplateId, Array<{ integrationId: string; type: string }>>> = {
  github: [{ integrationId: "github", type: "orvyn-github" }],
  deployment: [
    { integrationId: "github", type: "orvyn-github" },
    { integrationId: "vercel", type: "orvyn-vercel" },
    { integrationId: "netlify", type: "orvyn-netlify" },
    { integrationId: "cloudflare", type: "orvyn-cloudflare" },
  ],
};

/** Customer-facing names. Never a vendor or runtime name. */
export const TEMPLATE_LABELS: Record<PolicyTemplateId, string> = {
  "code-basic": "No network",
  "web-development": "Package registries and CDNs",
  research: "Reference documentation and owner-approved public sites",
  github: "GitHub (clone, fetch, push)",
  deployment: "GitHub and deploy providers",
  "server-admin": "SSH to specific servers",
};

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/** Public hostnames or public IPv4 only (same rule as the worker's renderer). */
export function publicHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h || h === "localhost" || /\.(local|internal|localhost)$/.test(h)) return false;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const [a, b, c, d] = ip.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  return HOST_RE.test(h);
}

export type RequestOutcome =
  | { ok: true; request: PolicyRequest; message: string }
  | { ok: false; code: "NO_SANDBOX" | "NOT_SUPPORTED" | "NOT_ON_PLAN" | "BAD_REQUEST"; message: string };

export async function requestNetworkAccess(
  registry: SandboxOperations,
  input: { runId: string; template: string; hosts?: string[]; reason?: string; planId: string | null },
): Promise<RequestOutcome> {
  const rec = await registry.forRun(input.runId);
  if (!rec) return { ok: false, code: "NO_SANDBOX", message: "This run has no cloud workspace, so there is no network policy to change." };
  if (!(POLICY_TEMPLATES as string[]).includes(input.template) || input.template === "code-basic") {
    return { ok: false, code: "BAD_REQUEST", message: `Unknown access profile. Choose one of: ${POLICY_TEMPLATES.filter((t) => t !== "code-basic").join(", ")}.` };
  }
  const template = input.template as PolicyTemplateId;
  if (rec.provider !== "openshell") {
    return { ok: false, code: "NOT_SUPPORTED", message: "This workspace runs without network access and cannot open it. Continue without the network, or ask the user to run this step on their computer." };
  }
  if (!templatesForPlan(input.planId).includes(template)) {
    return { ok: false, code: "NOT_ON_PLAN", message: `The "${TEMPLATE_LABELS[template]}" access profile is not included in this account's plan.` };
  }
  const hosts = [...new Set((input.hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))].slice(0, 5);
  if (template === "server-admin" || template === "research") {
    if (template === "server-admin" && !hosts.length) return { ok: false, code: "BAD_REQUEST", message: "SSH access needs the server hostname(s)." };
    const bad = hosts.filter((h) => !publicHost(h));
    if (bad.length) return { ok: false, code: "BAD_REQUEST", message: `Not allowed: ${bad.join(", ")}. Only public hostnames or addresses.` };
  }
  const request = await registry.requestPolicy({
    sandboxId: rec.id, runId: input.runId, organizationId: rec.organizationId, template,
    params: template === "server-admin" || template === "research" ? { host: hosts } : {},
    reason: input.reason, requestedBy: `model:${input.runId}`,
  });
  await registry.audit("policy.expansion.requested", `model:${input.runId}`, { sandboxId: rec.id, organizationId: rec.organizationId, detail: { requestId: request.id, template, hosts } });
  return {
    ok: true, request,
    message: `Requested "${TEMPLATE_LABELS[template]}" access. A workspace owner must approve it; until then the network stays closed. Continue with work that does not need it, and tell the user what is waiting on approval. Do not retry the blocked command or look for a way around the policy.`,
  };
}

export async function decideRequest(registry: SandboxOperations, id: string, approve: boolean, actor: string, scope: { organizationId?: string } = {}): Promise<PolicyRequest | null> {
  const cur = await registry.policyRequest(id);
  if (!cur) return null;
  if (scope.organizationId && cur.organizationId !== scope.organizationId) return null;
  const out = await registry.decidePolicy(id, approve, actor);
  if (out && out.status !== cur.status) {
    await registry.audit(approve ? "policy.expansion.approved" : "policy.expansion.denied", actor, { sandboxId: cur.sandboxId, organizationId: cur.organizationId, detail: { requestId: id, template: cur.template, params: cur.params } });
  }
  return out;
}

/** What the worker receives with its next tool poll, if anything. */
export async function pendingPolicyUpdate(registry: SandboxOperations, runId: string): Promise<null | { requestId: string; template: string; params: Record<string, string[]>; credentials: Array<{ organizationId: string; integrationId: string; type: string }> }> {
  const req = await registry.nextApproved(runId);
  if (!req) return null;
  const creds = (TEMPLATE_CREDENTIALS[req.template as PolicyTemplateId] ?? []).map((c) => ({ ...c, organizationId: req.organizationId }));
  return { requestId: req.id, template: req.template, params: req.params, credentials: creds };
}

/**
 * Whether the worker may fetch this integration's credential for this run:
 * the run's sandbox is OpenShell, still live, and a person approved a
 * template that needs exactly this integration.
 */
export async function credentialAllowed(registry: SandboxOperations, runId: string, integrationId: string): Promise<{ ok: true; organizationId: string; tenantId: string; sandboxId: string } | { ok: false }> {
  const templates=Object.entries(TEMPLATE_CREDENTIALS).filter(([,credentials])=>credentials?.some(c=>c.integrationId===integrationId)).map(([template])=>template);
  const rec=await registry.authorizedSandbox(runId,templates);
  return rec?{ok:true,organizationId:rec.organizationId,tenantId:rec.tenantId,sandboxId:rec.id}:{ok:false};
}
