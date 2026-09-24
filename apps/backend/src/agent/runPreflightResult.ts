// Authoritative preflight. No tools run here. The model sees only what this returns.

import { routeExecutionTarget } from "../execution/ExecutionTarget";
import { classifyExecutionHints } from "../execution/classifyExecution";
import { inspectWorkspace, type WorkspaceContext } from "./workspaceContext";
import { inferTaskIntent, type TaskIntent } from "./taskIntent";
import { resolveResources, type RegisteredResource, type ResolveResult } from "./resourceResolver";
import { selectToolNames } from "./toolPolicy";
import { evaluatePreflight } from "./runPreflight";

export interface RunPreflightResult {
  intent: TaskIntent;
  workspace: WorkspaceContext;
  resources: ResolveResult;
  executionTarget: "local_host" | "local_sandbox" | "cloud_worker" | "remote_resource";
  relevantTools: string[];
  blockers: string[];
  canExecute: boolean;
}

export function prepareRunPreflight(input: {
  instruction: string;
  projectRoot: string;
  tenantId: string;
  organizationId: string;
  projectId: string | null;
  resources: RegisteredResource[];
  toolNames: string[];
  hasLocalProject: boolean;
  cloudControlPlane: boolean;
  cloudWorkspaceAvailable: boolean;
  composerMode?: string;
  /** Where this run's tools actually execute, when the route already decided.
   *  Preflight reports it instead of re-guessing from the control plane's disk. */
  actualTarget?: "local_host" | "local_sandbox" | "ovh_worker";
}): RunPreflightResult {
  const intent = inferTaskIntent(input.instruction, input.composerMode);
  const workspace = inspectWorkspace(input.projectRoot);
  const resources = resolveResources({
    intent,
    instruction: input.instruction,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    resources: input.resources,
  });
  const hints = classifyExecutionHints(input.instruction, input.composerMode);
  const routed = routeExecutionTarget({
    requested: "auto",
    mode: input.composerMode,
    hasLocalProject: input.hasLocalProject && workspace.available,
    cloudControlPlane: input.cloudControlPlane,
    isArtifact: hints.isArtifact || intent.requiresArtifact,
    isLocalCoding: hints.isLocalCoding,
    isSite: hints.isSite || intent.requiresFrontend,
    isRisky: hints.isRisky,
    requiresRemote: intent.requiresRemoteResource || hints.requiresRemote,
  });
  const executionTarget =
    intent.requiresRemoteResource && resources.status === "ok"
      ? "remote_resource"
      : (input.actualTarget ?? routed.actual) === "ovh_worker"
        ? "cloud_worker"
        : (input.actualTarget ?? routed.actual) === "local_sandbox"
          ? "local_sandbox"
          : "local_host";
  const relevantTools = selectToolNames(input.toolNames, intent, { repositoryDetected: workspace.repositoryDetected });
  const blockers: string[] = [];
  const diagnosis = evaluatePreflight({ intent, workspace, servers: input.resources });
  if (diagnosis.status === "blocked" && diagnosis.message) blockers.push(diagnosis.message);
  if (intent.requiresWorkspace && !workspace.available && !input.cloudWorkspaceAvailable && !intent.informational && !intent.requiresArtifact) {
    blockers.push("I don't have a workspace for this yet. Open a project or start a cloud workspace and I'll continue from here.");
  }
  if (resources.status === "blocked" && !intent.requiresFrontend) blockers.push(resources.message);
  if (/\b(git|repository|repo)\b/i.test(input.instruction) && !workspace.repositoryDetected && !intent.informational) {
    blockers.push("This task needs a git repository, and none is mounted.");
  }
  return {
    intent,
    workspace,
    resources,
    executionTarget,
    relevantTools,
    blockers,
    canExecute: blockers.length === 0,
  };
}
