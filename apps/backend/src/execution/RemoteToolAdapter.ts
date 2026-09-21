// apps/backend/src/execution/RemoteToolAdapter.ts
//
// Maps ORION's existing tool names to remote execution via the ToolRpc
// channel. These adapters are registered into the SAME ToolGateway —
// the model uses the same logical tools (read_file, edit_file, terminal)
// whether execution is LOCAL or OVH_WORKER. Only the provider changes.
//
// Security: model credentials stay in the control plane. The worker
// never sees provider API keys. The ToolRpc channel carries only
// tool names + arguments + results.

import { AITool, ToolResult } from "../ai/ToolTypes";
import type { ToolRpcChannel } from "./ToolRpc";

function makeRemoteTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  defaultPermission: "allowed" | "ask" | "denied",
  rpc: ToolRpcChannel,
  runId: string
): AITool {
  return {
    name,
    description: `[REMOTE] ${description}`,
    parameters,
    defaultPermission,
    async execute(args): Promise<ToolResult> {
      const start = Date.now();
      try {
        const response = await rpc.execute(runId, name, args, 120_000);
        if (response.ok) {
          return { ok: true, output: response.output ?? "" };
        }
        return {
          ok: false,
          error: response.error ?? `Remote tool failed (exit ${response.exitCode ?? "?"})${response.stderr ? `: ${response.stderr.slice(0, 200)}` : ""}`,
        };
      } catch (err: any) {
        return { ok: false, error: `Remote execution error: ${err.message}` };
      }
      void start;
    },
  };
}

/**
 * Registers remote versions of ORION's core coding tools into the
 * ToolGateway. Called when executionLocation is OVH_WORKER.
 * These REPLACE the local tools for the duration of the run.
 */
export function registerRemoteTools(
  gateway: { register(tool: AITool): void },
  rpc: ToolRpcChannel,
  runId: string
): void {
  gateway.register(makeRemoteTool(
    "read_file",
    "Read a file from the remote workspace",
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    "allowed",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "write_file",
    "Write/create a file in the remote workspace",
    {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    "ask",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "edit_file",
    "Edit a file in the remote workspace (find and replace)",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    "ask",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "list_directory",
    "List files in a directory in the remote workspace",
    { type: "object", properties: { path: { type: "string" } } },
    "allowed",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "search_code",
    "Search for a pattern in remote workspace files",
    {
      type: "object",
      properties: { query: { type: "string" }, pattern: { type: "string" } },
    },
    "allowed",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "terminal",
    "Run a terminal command in the remote mission container",
    { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    "ask",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "run_tests",
    "Run the project's test suite in the remote container",
    { type: "object", properties: {} },
    "ask",
    rpc, runId
  ));

  gateway.register(makeRemoteTool(
    "run_typecheck",
    "Run the project's typecheck in the remote container",
    { type: "object", properties: {} },
    "ask",
    rpc, runId
  ));
}
