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
import { diffLines } from "../composer/diff";
import type { ToolRpcChannel } from "./ToolRpc";

/**
 * Per-request ceiling for a remote tool call. File ops are fast; commands
 * may legitimately take minutes (npm install, slow suites), so this is
 * tunable per deployment via ORVYN_REMOTE_TOOL_TIMEOUT_MS.
 */
function remoteToolTimeoutMs(): number {
  const v = Number(process.env.ORVYN_REMOTE_TOOL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

/** Caps the diff sent back for huge files — same spirit as editPreview. */
const MAX_DIFF_LINES = 400;

function toToolResultEdit(path: string, kind: "create" | "modify", before: string, after: string): ToolResult["edit"] {
  const lines = diffLines(before, after).slice(0, MAX_DIFF_LINES);
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.type === "add") additions++;
    else if (l.type === "remove") deletions++;
  }
  return { path, kind, additions, deletions, diff: lines.map((l) => ({ type: l.type, content: l.content })) };
}

function makeRemoteTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  defaultPermission: "allowed" | "ask" | "denied",
  rpc: ToolRpcChannel,
  runId: string,
  execute?: (args: Record<string, unknown>, raw: () => Promise<ToolResult>) => Promise<ToolResult>
): AITool {
  return {
    name,
    description: `[REMOTE] ${description}`,
    parameters,
    defaultPermission,
    async execute(args): Promise<ToolResult> {
      const start = Date.now();
      try {
        if (execute) return await execute(args, async () => {
          const response = await rpc.execute(runId, name, args, remoteToolTimeoutMs());
          return rpcResponseToResult(name, response);
        });
        const response = await rpc.execute(runId, name, args, remoteToolTimeoutMs());
        return rpcResponseToResult(name, response);
      } catch (err: any) {
        return { ok: false, error: `Remote execution error: ${err.message}` };
      } finally {
        void start;
      }
    },
  };
}

function rpcResponseToResult(name: string, response: { ok: boolean; output?: string; stderr?: string; exitCode?: number; error?: string }): ToolResult {
  if (response.ok) return { ok: true, output: response.output ?? "" };
  return {
    ok: false,
    error: response.error ?? `Remote tool failed (exit ${response.exitCode ?? "?"})${response.stderr ? `: ${response.stderr.slice(0, 200)}` : ""}`,
  };
}

/** Reads a remote file as text; returns null when the read fails. */
async function readRemote(rpc: ToolRpcChannel, runId: string, path: string): Promise<string | null> {
  try {
    const r = await rpc.execute(runId, "read_file", { path }, remoteToolTimeoutMs());
    return r.ok ? String(r.output ?? "") : null;
  } catch {
    return null;
  }
}

/**
 * Registers remote versions of ORION's core coding tools into the
 * ToolGateway. Called when executionLocation is OVH_WORKER.
 * These REPLACE the local tools for the duration of the run; the runtime
 * restores the originals when the run settles.
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
    rpc, runId,
    // Create diffs ride back with the result so file.edit events show real
    // content, not just a path.
    async (args, raw) => {
      const result = await raw();
      if (!result.ok) return result;
      const after = await readRemote(rpc, runId, String(args.path ?? ""));
      return { ...result, edit: after !== null ? toToolResultEdit(String(args.path ?? ""), "create", "", after) : undefined };
    }
  ));

  gateway.register(makeRemoteTool(
    "edit_file",
    "Edit a file in the remote workspace (find and replace). old_string must match uniquely unless replace_all is true.",
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
    rpc, runId,
    // The diff is computed from the remote file on both sides of the edit —
    // the control plane never assumes the file's local state.
    async (args, raw) => {
      const path = String(args.path ?? "");
      const before = await readRemote(rpc, runId, path);
      const result = await raw();
      if (!result.ok) return result;
      if (before === null) return result;
      const after = await readRemote(rpc, runId, path);
      if (after === null) return result;
      return { ...result, edit: toToolResultEdit(path, "modify", before, after) };
    }
  ));

  gateway.register(makeRemoteTool(
    "list_directory",
    "List files in a directory in the remote workspace",
    { type: "object", properties: { path: { type: "string" } } },
    "allowed",
    rpc, runId
  ));

  const searchParams = {
    type: "object",
    properties: { query: { type: "string" }, pattern: { type: "string" } },
  };
  gateway.register(makeRemoteTool("search_code", "Search for a pattern in remote workspace files", searchParams, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("search_files", "Search for a pattern in remote workspace files", searchParams, "allowed", rpc, runId));

  const terminalParams = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
  gateway.register(makeRemoteTool("terminal", "Run a terminal command in the remote mission container", terminalParams, "ask", rpc, runId));
  gateway.register(makeRemoteTool("run_command", "Run a terminal command in the remote mission container", terminalParams, "ask", rpc, runId));

  gateway.register(makeRemoteTool(
    "run_tests",
    "Run the project's test suite (npm test) in the remote mission container",
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
