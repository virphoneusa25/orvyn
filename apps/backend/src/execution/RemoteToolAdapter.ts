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
import { WRITE_FILE_DESCRIPTION, WRITE_FILE_PARAMETERS } from "../ai/tools/fileTools";
import { diffLines } from "../composer/diff";
import type { ToolRpcChannel } from "./ToolRpc";
import { sha256Hex, validateBytes } from "../artifacts/bytes";
import { mediaTypeForName } from "../artifacts/ArtifactService";
import type { ProjectFileEvidence } from "../artifacts/projectFileEvidence";

/**
 * Per-request ceiling for a remote tool call. File ops are fast; commands
 * may legitimately take minutes (npm install, slow suites), so this is
 * tunable per deployment via ORVYN_REMOTE_TOOL_TIMEOUT_MS.
 */
function remoteToolTimeoutMs(): number {
  const v = Number(process.env.ORVYN_REMOTE_TOOL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 330_000;
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

function rpcResponseToResult(name: string, response: { ok: boolean; output?: string; stderr?: string; exitCode?: number; error?: string; meta?: Record<string, unknown> }): ToolResult {
  if (response.ok) return { ok: true, output: response.output ?? "", ...(response.meta ? { meta: response.meta } : {}) };
  const err = response.error ?? `Remote tool failed (exit ${response.exitCode ?? "?"})`;
  // A failing command still carries the evidence — test output, compiler
  // errors, grep misses. Surface it so the model can diagnose the failure
  // instead of being blind to the very output it asked for.
  const evidence = `${(response.output ?? "").trim()}${response.stderr ? `\n${response.stderr.trim()}` : ""}`.trim();
  return evidence
    ? { ok: false, error: `${err}\n--- output ---\n${evidence.slice(-4000)}` }
    : { ok: false, error: err };
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

function remoteFileEvidence(projectRoot: string, filePath: string, content: string): ProjectFileEvidence {
  const path = filePath.replace(/\\/g, "/");
  const name = path.split("/").pop() || path;
  const bytes = Buffer.from(content, "utf-8");
  const mimeType = mediaTypeForName(name);
  if (mimeType.startsWith("image/")) validateBytes(name, mimeType, bytes);
  return { projectRoot, path, name, mimeType, size: bytes.length, exists: true, readable: true, sha256: sha256Hex(bytes), createdAt: new Date().toISOString() };
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
  runId: string,
  projectRoot = "remote-workspace"
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
    WRITE_FILE_DESCRIPTION,
    WRITE_FILE_PARAMETERS as unknown as Record<string, unknown>,
    "ask",
    rpc, runId,
    // Create diffs ride back with the result so file.edit events show real
    // content, not just a path.
    async (args, raw) => {
      const append = args.append === true;
      const before = append ? (await readRemote(rpc, runId, String(args.path ?? ""))) ?? "" : "";
      const result = await raw();
      if (!result.ok) return result;
      const after = await readRemote(rpc, runId, String(args.path ?? ""));
      if (after === null || after !== before + String(args.content ?? "")) return { ok: false, error: "Remote project file read-back failed." };
      try {
        return { ...result, projectFileEvidence: remoteFileEvidence(projectRoot, String(args.path ?? ""), after), edit: toToolResultEdit(String(args.path ?? ""), append ? "modify" : "create", before, after) };
      } catch (err: any) { return { ok: false, error: err.message }; }
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
      if (before === null) return { ok: false, error: "Remote project file before-state unavailable." };
      const after = await readRemote(rpc, runId, path);
      if (after === null) return { ok: false, error: "Remote project file read-back failed." };
      try {
        return { ...result, projectFileEvidence: remoteFileEvidence(projectRoot, path, after), edit: toToolResultEdit(path, "modify", before, after) };
      } catch (err: any) { return { ok: false, error: err.message }; }
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

  const gitRead = { type: "object", properties: {} };
  gateway.register(makeRemoteTool("git_status", "git status in the execution workspace", gitRead, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("git_diff", "git diff in the execution workspace", gitRead, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("git_log", "git log in the execution workspace", { type: "object", properties: { limit: { type: "number" }, path: { type: "string" } } }, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("git_branch", "git branch in the execution workspace", gitRead, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("git_checkout", "Switch branch in the execution workspace", { type: "object", properties: { branch: { type: "string" }, create: { type: "boolean" } }, required: ["branch"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("git_commit", "Commit in the execution workspace (never automatic)", { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("delete_file", "Delete a file in the execution workspace", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("start_process", "Start a long-running local process / dev server", { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("stop_process", "Stop a process this run started", { type: "object", properties: { processId: { type: "string" }, id: { type: "string" } } }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("read_process_logs", "Read logs from a tracked process", { type: "object", properties: { processId: { type: "string" }, id: { type: "string" } } }, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("list_processes", "List processes ORION started for this project", gitRead, "allowed", rpc, runId));

  // Browser state and MCP child processes live inside the mission sandbox.
  // The control plane keeps the same logical tool names and permission gates.
  const browserSession = { type: "string", description: "Browser session id (the sandbox has one session per run)" };
  gateway.register(makeRemoteTool("browser_open", "Open a URL in the sandbox browser", { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_navigate", "Navigate the sandbox browser", { type: "object", properties: { url: { type: "string" }, sessionId: browserSession }, required: ["url"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_set_viewport", "Resize the sandbox browser", { type: "object", properties: { preset: { type: "string", enum: ["desktop", "tablet", "mobile"] }, width: { type: "number" }, height: { type: "number" }, sessionId: browserSession } }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_click", "Click an element in the sandbox browser", { type: "object", properties: { selector: { type: "string" }, sessionId: browserSession }, required: ["selector"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_type", "Type into an element in the sandbox browser", { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, sessionId: browserSession }, required: ["selector", "text"] }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_scroll", "Scroll the sandbox browser", { type: "object", properties: { deltaY: { type: "number" }, sessionId: browserSession } }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_console_errors", "Report browser console and network errors from inside the sandbox", { type: "object", properties: { sessionId: browserSession } }, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("browser_screenshot", "Capture the sandbox browser viewport", { type: "object", properties: { fullPage: { type: "boolean" }, sessionId: browserSession } }, "ask", rpc, runId));
  gateway.register(makeRemoteTool("browser_evidence", "Return sandbox browser URL, errors, actions and screenshots", { type: "object", properties: { sessionId: browserSession } }, "allowed", rpc, runId));

  gateway.register(makeRemoteTool("mcp_list", "List tools from MCP servers configured in .orvyn/mcp.json; stdio servers run inside the sandbox", { type: "object", properties: {} }, "allowed", rpc, runId));
  gateway.register(makeRemoteTool("mcp_call", "Call an MCP tool inside the sandbox", { type: "object", properties: { server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["server", "tool"] }, "ask", rpc, runId));
}
