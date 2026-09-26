// Which tools a run may see, and which arguments are safe to execute.
// Irrelevant families stay off the model request. Empty required fields never
// reach ToolGateway.

import type { TaskIntent } from "./taskIntent";

const SERVER = /^(ssh_exec|remote_exec)$/;
/** Dev servers and watchers: any task that runs commands in a project may need one. */
const SERVICE = /^(start_process|stop_process|read_process_logs|list_processes)$/;
const BROWSER = /^browser_/;
const DESKTOP = /^(desktop_|computer[._])/;
const ARTIFACT = /^(generate_image|artifact_|create_document|create_zip)$/;
/** MCP tools stay off until the task needs them; search_capabilities is always there so ORION can ask for a missing tool. */
const MCP = /^mcp[._]/i;
const GIT = /^git_/;

export function selectToolNames(
  names: string[],
  intent: TaskIntent,
  options?: { repositoryDetected?: boolean }
): string[] {
  const gitAllowed = options?.repositoryDetected !== false;
  return names.filter((name) => {
    if (GIT.test(name) && !gitAllowed) return false;
    if (SERVER.test(name) && !intent.requiresRemoteResource && intent.category !== "server" && intent.category !== "deploy") {
      return false;
    }
    if (SERVICE.test(name) && !intent.requiresTerminal && !intent.requiresFrontend && intent.category !== "server" && intent.category !== "deploy") {
      return false;
    }
    if (BROWSER.test(name) && !intent.requiresBrowser && intent.category !== "browser") return false;
    if (DESKTOP.test(name) && !intent.requiresDesktop && intent.category !== "desktop") return false;
    if (ARTIFACT.test(name) && !intent.requiresArtifact && intent.category !== "artifact") return false;
    if (MCP.test(name) && !intent.requiresExternalIntegration && intent.category !== "integration") return false;
    return true;
  });
}

export interface ToolParameterSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

const REQUIRED_BY_TOOL: Record<string, string[]> = {
  ssh_exec: ["host", "command"],
  remote_exec: ["resourceId", "command"],
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  delete_file: ["path"],
  terminal: ["command"],
  run_command: ["command"],
};

/** A website is published from the files the agent writes. A shell server is not available. */
export function shellServerRefusal(command: string, frontend: boolean): string | null {
  if (!frontend) return null;
  if (!/\bpython3?\b|http\.server|which python|npx serve|live-server/i.test(command)) return null;
  return "Do not start a shell server. python3 is not installed in this workspace. Call write_file for the new site's index.html and its stylesheet. Do not replace site files that were already written. The preview is published from the new files.";
}

export function validateToolArguments(
  name: string,
  raw: unknown,
  schema?: ToolParameterSchema
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const required = [...new Set([...(schema?.required ?? []), ...(REQUIRED_BY_TOOL[name] ?? [])])];
  for (const field of required) {
    const value = args[field];
    if (value == null || (typeof value === "string" && value.trim() === "")) {
      if (name === "ssh_exec" || name === "remote_exec") {
        return {
          ok: false,
          error: `${name} needs a non-empty ${field}. Do not call it with an empty host or command. If no server is connected, stop and ask for one.`,
        };
      }
      return { ok: false, error: `${name} is missing required argument "${field}".` };
    }
  }
  return { ok: true, args };
}
