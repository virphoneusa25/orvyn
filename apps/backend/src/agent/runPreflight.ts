import type { TaskIntent } from "./taskIntent";
import type { RegisteredResource } from "./resourceResolver";
import type { WorkspaceContext } from "./workspaceContext";

export interface PreflightResult {
  status: "ok" | "blocked";
  message?: string;
  actions?: string[];
}

const DIAGNOSE = /\b(diagnos\w*|failing service|service is (down|failing)|health[- ]check|why .{0,40}(down|failing|unhealthy))\b/i;

export function needsLiveSystem(intent: TaskIntent): boolean {
  return DIAGNOSE.test(intent.goal) || intent.category === "server" || intent.requiresRemoteResource;
}

/**
 * A diagnosis needs a repository or a connected server. A project label is not enough.
 * This runs before the model, so git and MCP are never used as discovery fallbacks.
 */
export function evaluatePreflight(input: {
  intent: TaskIntent;
  workspace: WorkspaceContext;
  servers: RegisteredResource[];
}): PreflightResult {
  if (!needsLiveSystem(input.intent)) return { status: "ok" };
  const server = input.servers.some((s) => s.type === "server" && s.status === "ready" && s.authorized);
  if (input.workspace.repositoryDetected || server) return { status: "ok" };
  if (input.intent.requiresRemoteResource || input.intent.category === "server") {
    return { status: "ok" };
  }
  return {
    status: "blocked",
    message: "I don't have a project, server, or environment connected to inspect yet. Connect one and I'll continue from here.",
    actions: ["Open local project", "Clone repository", "Connect server"],
  };
}
