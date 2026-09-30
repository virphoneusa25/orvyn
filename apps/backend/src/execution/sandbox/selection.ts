// apps/backend/src/execution/sandbox/selection.ts
//
// Which execution sandbox a cloud mission gets, decided on the control plane
// (never by the client or the model):
//
//   ORVYN_EXECUTION_PROVIDER = docker | openshell | auto   (default docker)
//   OPENSHELL_ENABLED        = true to allow OpenShell at all (default off)
//   OPENSHELL_CANARY_ORGS    = comma-separated organization ids (canary)
//   OPENSHELL_CANARY_PERCENT = 0-100, honored only with OPENSHELL_ACCEPTANCE_PASSED=true
//
// An organization (or project) reaches OpenShell only when the deployment
// enables it AND it is in the canary: flag `openshell_runtime` on the org or
// project, or listed in OPENSHELL_CANARY_ORGS, or inside the percentage
// rollout once acceptance has passed. A flag set to false always wins.
//
// `auto` falls back to Docker when the gateway is unavailable; `openshell`
// does not (the run fails truthfully). Either way the choice is recorded.

import { createHash, randomUUID } from "node:crypto";
import type { SandboxRegistry, SandboxProvider } from "./SandboxRegistry";

export const OPENSHELL_FLAG = "openshell_runtime";

export type PolicyTemplateId = "code-basic" | "web-development" | "research" | "github" | "deployment" | "server-admin";
export const POLICY_TEMPLATES: PolicyTemplateId[] = ["code-basic", "web-development", "research", "github", "deployment", "server-admin"];

export interface SandboxResources {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  commandTimeoutS: number;
  maxLifetimeS: number;
}

export interface CredentialGrant { organizationId: string; integrationId: string; type: string }

export interface SandboxPlan {
  sandboxId: string;
  provider: SandboxProvider;
  /** What the worker may do if the chosen provider is unavailable. */
  fallback: "docker" | "none";
  policyTemplate: PolicyTemplateId;
  resources: SandboxResources;
  retention: "ephemeral" | "retained";
  credentials: CredentialGrant[];
  /** Why this provider (admin-only; never shown to customers). */
  reason: string;
}

/**
 * Plan-tier limits. The floor equals the old fixed container (1 CPU, 1 GB,
 * 256 pids) so no plan gets less than before.
 */
export function resourcesForPlan(planId: string | null | undefined): SandboxResources {
  switch (planId) {
    case "starter": return { cpus: 1, memoryMb: 2048, pidsLimit: 512, commandTimeoutS: 300, maxLifetimeS: 7200 };
    case "pro": case "power": return { cpus: 2, memoryMb: 4096, pidsLimit: 1024, commandTimeoutS: 600, maxLifetimeS: 14_400 };
    case "business": case "team": case "enterprise": return { cpus: 4, memoryMb: 8192, pidsLimit: 2048, commandTimeoutS: 900, maxLifetimeS: 28_800 };
    default: return { cpus: 1, memoryMb: 1024, pidsLimit: 256, commandTimeoutS: 120, maxLifetimeS: 3600 };
  }
}

/** Templates a plan may request at all (a request still needs human approval). */
export function templatesForPlan(planId: string | null | undefined): PolicyTemplateId[] {
  switch (planId) {
    case "business": case "team": case "enterprise": return [...POLICY_TEMPLATES];
    case "pro": case "power": return ["code-basic", "web-development", "research", "github", "deployment"];
    case "starter": return ["code-basic", "web-development", "research", "github"];
    default: return ["code-basic", "web-development"];
  }
}

/** Retained sandboxes (reused by the next run of the same project) for paid plans on OpenShell. */
export function retentionFor(planId: string | null | undefined, projectId: string | null, provider: SandboxProvider, env: NodeJS.ProcessEnv = process.env): "ephemeral" | "retained" {
  if (env.ORVYN_SANDBOX_RETAIN !== "true" || !projectId || provider !== "openshell") return "ephemeral";
  return ["pro", "power", "business", "team", "enterprise"].includes(String(planId)) ? "retained" : "ephemeral";
}

function inPercent(organizationId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const n = parseInt(createHash("sha256").update(`canary:${organizationId}`).digest("hex").slice(0, 8), 16) % 100;
  return n < percent;
}

export interface SelectionInput {
  organizationId: string;
  tenantId: string;
  projectId: string | null;
  planId: string | null;
  runId: string;
  workspaceId: string;
}

export function openShellEligible(input: Pick<SelectionInput, "organizationId" | "projectId">, registry: Pick<SandboxRegistry, "flag">, env: NodeJS.ProcessEnv = process.env): { eligible: boolean; reason: string } {
  const mode = (env.ORVYN_EXECUTION_PROVIDER || "docker").toLowerCase();
  if (mode === "docker") return { eligible: false, reason: "provider policy: docker" };
  if (env.OPENSHELL_ENABLED !== "true") return { eligible: false, reason: "OpenShell disabled on this deployment" };
  const projectFlag = input.projectId ? registry.flag("project", input.projectId, OPENSHELL_FLAG) : null;
  const orgFlag = registry.flag("org", input.organizationId, OPENSHELL_FLAG);
  if (projectFlag === false || orgFlag === false) return { eligible: false, reason: "flag off for this organization/project" };
  if (projectFlag === true) return { eligible: true, reason: "project flag" };
  if (orgFlag === true) return { eligible: true, reason: "organization flag" };
  const canary = String(env.OPENSHELL_CANARY_ORGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (canary.includes(input.organizationId)) return { eligible: true, reason: "canary list" };
  const percent = Number(env.OPENSHELL_CANARY_PERCENT ?? 0);
  if (env.OPENSHELL_ACCEPTANCE_PASSED === "true" && inPercent(input.organizationId, percent)) return { eligible: true, reason: `rollout ${percent}%` };
  return { eligible: false, reason: "not in the OpenShell canary" };
}

/** Deterministic id for a retained project sandbox; random for ephemeral. */
export function sandboxIdFor(input: Pick<SelectionInput, "organizationId" | "projectId">, retention: "ephemeral" | "retained"): string {
  if (retention === "retained" && input.projectId) {
    return `sbx_p${createHash("sha256").update(`${input.organizationId}:${input.projectId}`).digest("hex").slice(0, 24)}`;
  }
  return `sbx_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function selectSandbox(input: SelectionInput, registry: Pick<SandboxRegistry, "flag">, env: NodeJS.ProcessEnv = process.env): SandboxPlan {
  const mode = (env.ORVYN_EXECUTION_PROVIDER || "docker").toLowerCase();
  const gate = openShellEligible(input, registry, env);
  const provider: SandboxProvider = gate.eligible ? "openshell" : "docker";
  const retention = retentionFor(input.planId, input.projectId, provider, env);
  return {
    sandboxId: sandboxIdFor(input, retention),
    provider,
    fallback: provider === "openshell" && mode === "openshell" ? "none" : "docker",
    // Every mission starts deny-all. Anything wider goes through an approved request.
    policyTemplate: "code-basic",
    resources: resourcesForPlan(input.planId),
    retention,
    credentials: [],
    reason: gate.reason,
  };
}
