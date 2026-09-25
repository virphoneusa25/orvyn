// apps/backend/src/ai/tools/processTools.ts
//
// Long-running processes (dev servers, watchers) for ORION. Every one is
// owned by ServiceManager: it belongs to the project, keeps running after
// the run finishes, and stops only when asked.

import { AITool, ToolResult } from "../ToolTypes";
import { runService, serviceManager, type ServiceRecord } from "../../services/ServiceManager";

function line(r: ServiceRecord): string {
  const age = Math.round((Date.now() - r.startedAt) / 1000);
  return `${r.serviceId}: ${r.command} — ${r.status}${r.url ? ` at ${r.url}` : ""} (started ${age}s ago${r.stopReason ? `, ${r.stopReason}` : ""})`;
}

export function makeStartProcessTool(projectRoot: string): AITool {
  return {
    name: "start_process",
    description:
      "Start a long-running service (dev server, watcher, API) in the project root. It keeps running after this run finishes. Returns a service id and its URL once it is listening. Use terminal for one-shot commands.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      const command = String(args.command ?? "").trim();
      if (!command) return { ok: false, error: "command is required" };
      const { result } = await runService({ command, cwd: projectRoot, projectRoot, onOutput: context?.onOutput, readyTimeoutMs: 90_000 });
      return result;
    },
  };
}

export function makeStopProcessTool(projectRoot: string): AITool {
  return {
    name: "stop_process",
    description: "Stop a service started with start_process (or a dev server started from terminal).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "ask",
    execute: async (args) => stopService(projectRoot, String(args.id ?? args.processId ?? "")),
  };
}

export function stopService(projectRoot: string, id: string): ToolResult {
  const r = serviceManager.get(id);
  if (!r || r.projectRoot !== projectRoot) return { ok: false, error: `Unknown service "${id}"` };
  if (r.status === "stopped" || r.status === "failed") return { ok: true, output: `${id} is not running (${r.stopReason ?? r.status})` };
  serviceManager.stop(id, "stopped by ORION");
  return { ok: true, output: `Stopped ${id}: ${r.command}` };
}

export function makeReadProcessLogsTool(projectRoot: string): AITool {
  return {
    name: "read_process_logs",
    description: "Read the recent output of a service (default: last 80 lines).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        tail: { type: "number", description: "How many trailing lines (default 80)" },
      },
      required: ["id"],
    },
    defaultPermission: "allowed",
    execute: async (args) => serviceLogs(projectRoot, String(args.id ?? args.processId ?? ""), Number(args.tail) || 80),
  };
}

export function serviceLogs(projectRoot: string, id: string, tail = 80): ToolResult {
  const r = serviceManager.get(id);
  if (!r || r.projectRoot !== projectRoot) return { ok: false, error: `Unknown service "${id}"` };
  const text = serviceManager.logs(id, Math.min(Math.max(tail, 1), 500));
  return { ok: true, output: `${line(r)}\n\n${text || "(no output yet)"}` };
}

export function makeListProcessesTool(projectRoot: string): AITool {
  return {
    name: "list_processes",
    description: "List the services running for this project and their status.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: async () => listServices(projectRoot),
  };
}

export function listServices(projectRoot: string): ToolResult {
  const rows = serviceManager.list({ projectRoot });
  return { ok: true, output: rows.length ? rows.map(line).join("\n") : "(no services)" };
}
