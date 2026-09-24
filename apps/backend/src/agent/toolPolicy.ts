// Which tools a run may see, and which arguments are safe to execute.
// Irrelevant families stay off the model request. Empty required fields never
// reach ToolGateway.

import type { TaskIntent } from "./taskIntent";

const SERVER = /^(ssh_exec|remote_exec|start_process|stop_process|read_process_logs|list_processes)$/;
const BROWSER = /^browser_/;
const DESKTOP = /^(desktop_|computer[._])/;
const ARTIFACT = /^(generate_image|artifact_|create_document|create_zip)$/;
const MCP = /^(mcp[._]|search_capabilities$)/;

export function selectToolNames(names: string[], intent: TaskIntent): string[] {
  return names.filter((name) => {
    if (SERVER.test(name) && !intent.requiresRemoteResource && intent.category !== "server" && intent.category !== "deploy") {
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
