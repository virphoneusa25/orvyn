// Picks the resources a task may use. Missing or ambiguous consequential
// targets stop the run. The model never receives secrets or empty hosts.

import { readFileSync } from "fs";
import { sshConfigPath } from "../ai/tools/sshTools";
import type { TaskIntent } from "./taskIntent";

export type ResourceType =
  | "workspace"
  | "repository"
  | "server"
  | "database"
  | "cloud_account"
  | "deployment"
  | "browser_session"
  | "desktop_session"
  | "mcp"
  | "artifact_store";

export interface RegisteredResource {
  resourceId: string;
  tenantId: string;
  organizationId: string;
  authorized: boolean;
  projectId: string | null;
  type: ResourceType;
  capabilities: string[];
  status: "ready" | "offline" | "unknown";
  labels: string[];
}

export interface ResolveInput {
  intent: TaskIntent;
  instruction: string;
  tenantId: string;
  organizationId: string;
  projectId: string | null;
  resources: RegisteredResource[];
}

export type ResolveResult =
  | { status: "ok"; resources: RegisteredResource[] }
  | {
      status: "blocked";
      code: "RESOURCE_REQUIRED" | "RESOURCE_AMBIGUOUS";
      resourceType: ResourceType;
      message: string;
      choices?: string[];
    };

function visible(resources: RegisteredResource[], tenantId: string, type: ResourceType): RegisteredResource[] {
  return resources.filter((r) => r.type === type && r.authorized && r.tenantId === tenantId && r.status === "ready");
}

function named(instruction: string, resources: RegisteredResource[]): RegisteredResource | undefined {
  const text = instruction.toLowerCase();
  return resources.find((r) => r.labels.some((label) => label && text.includes(label.toLowerCase())));
}

export function resolveResources(input: ResolveInput): ResolveResult {
  const { intent, instruction, tenantId } = input;
  const picked: RegisteredResource[] = [];

  if (intent.requiresRemoteResource) {
    const servers = visible(input.resources, tenantId, "server");
    if (servers.length === 0) {
      return {
        status: "blocked",
        code: "RESOURCE_REQUIRED",
        resourceType: "server",
        message: "No server is connected for this workspace. Connect a server, then ask again. SSH was not called.",
      };
    }
    const match = named(instruction, servers);
    if (servers.length > 1 && !match) {
      const choices = servers.map((s) => s.labels[0] || s.resourceId);
      return {
        status: "blocked",
        code: "RESOURCE_AMBIGUOUS",
        resourceType: "server",
        choices,
        message: `More than one server is connected (${choices.join(", ")}). Say which one to use. None was guessed.`,
      };
    }
    picked.push(match ?? servers[0]);
  }

  if (intent.category === "database") {
    const databases = visible(input.resources, tenantId, "database");
    if (databases.length === 0) {
      return {
        status: "blocked",
        code: "RESOURCE_REQUIRED",
        resourceType: "database",
        message: "No database is connected for this workspace. Connect one before querying. No database call was made.",
      };
    }
    const match = named(instruction, databases);
    if (databases.length > 1 && !match) {
      const choices = databases.map((s) => s.labels[0] || s.resourceId);
      return {
        status: "blocked",
        code: "RESOURCE_AMBIGUOUS",
        resourceType: "database",
        choices,
        message: `More than one database is connected (${choices.join(", ")}). Say which one to use.`,
      };
    }
    picked.push(match ?? databases[0]);
  }

  return { status: "ok", resources: picked };
}

/** Project SSH allowlist, as resource records. Hosts and keys stay on disk. */
export function resourcesFromProject(projectRoot: string, scope: {
  tenantId: string;
  organizationId: string;
  projectId: string | null;
}): RegisteredResource[] {
  if (!projectRoot) return [];
  try {
    const parsed = JSON.parse(readFileSync(sshConfigPath(projectRoot), "utf8")) as {
      hosts?: Array<{ alias?: string }>;
    };
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
    return hosts
      .filter((h) => h && String(h.alias ?? "").trim())
      .map((h) => {
        const alias = String(h.alias).trim();
        return {
          resourceId: `server:${alias}`,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          authorized: true,
          projectId: scope.projectId,
          type: "server" as const,
          capabilities: ["remoteShell"],
          status: "ready" as const,
          labels: [alias],
        };
      });
  } catch {
    return [];
  }
}
