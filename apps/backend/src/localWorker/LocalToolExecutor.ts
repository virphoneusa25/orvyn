import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import {
  makeDeleteFileTool,
  makeEditFileTool,
  makeListDirectoryTool,
  makeReadFileTool,
  makeSearchFilesTool,
  makeWriteFileTool,
} from "../ai/tools/fileTools";
import { makeSearchCodeTool } from "../ai/tools/searchCodeTool";
import { makeGitBranchTool, makeGitCheckoutTool, makeGitCommitTool, makeGitDiffTool, makeGitLogTool, makeGitStatusTool } from "../ai/tools/gitTools";
import { isDestructiveCommand, makeTerminalTool, normalizeWindowsCommand } from "../ai/tools/terminalTool";
import { makeRunTestsTool, makeRunTypecheckTool } from "../ai/tools/diagnosticsTools";
import { resolveSafePath, resolveSafeRealpath } from "../execution/pathSafety";
import { acquireFileLock, fileHash, releaseFileLock } from "./fileLock";
import { processTracker } from "./processTracker";
import type { ToolResult } from "../ai/ToolTypes";
import {
  makeHostDesktopClickTool,
  makeHostDesktopFocusTool,
  makeHostDesktopMoveTool,
  makeHostDesktopScreenshotTool,
  makeHostDesktopScrollTool,
  makeHostDesktopStatusTool,
  makeHostDesktopTypeTool,
} from "../ai/tools/hostDesktopTools";

export interface LocalToolRequest {
  tool: string;
  arguments: Record<string, unknown>;
  runId?: string;
  tenantId?: string;
  projectRoot: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface LocalToolResponse extends ToolResult {
  previews?: { url: string; port?: number; label: string }[];
}

const SECRET_NAMES = new Set([".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", ".npmrc"]);

export function isSecretPath(rel: string): boolean {
  const base = path.basename(rel);
  if (SECRET_NAMES.has(base)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (/(^|[/\\])(\.git[/\\])?credentials$/i.test(rel)) return true;
  return false;
}

export async function executeLocalTool(req: LocalToolRequest): Promise<LocalToolResponse> {
  const root = req.projectRoot;
  const args = req.arguments ?? {};
  const tools = bindTools(root, req.tenantId || "local");

  if (req.tool === "read_file" || req.tool === "write_file" || req.tool === "edit_file") {
    const rel = String(args.path ?? "");
    if (isSecretPath(rel) && req.tool !== "read_file") {
      return { ok: false, error: `Refusing to write secret-like path ${rel}` };
    }
  }

  if (req.tool === "write_file" || req.tool === "edit_file") {
    const rel = String(args.path ?? "");
    const target = resolveSafePath(root, rel);
    let current = "";
    try { current = await fs.readFile(target, "utf-8"); } catch { /* create */ }
    const expected = typeof args.expectedHash === "string" ? args.expectedHash : undefined;
    if (expected && current && fileHash(current) !== expected) {
      return { ok: false, error: `File ${rel} changed externally since it was read. Re-read before overwriting.` };
    }
    const lock = acquireFileLock(target, req.runId ?? "local", fileHash(current));
    if (!lock.ok) return { ok: false, error: lock.error };
    try {
      const result = await tools[req.tool].execute(args);
      return result;
    } finally {
      releaseFileLock(target, req.runId ?? "local");
    }
  }

  if (req.tool === "terminal" || req.tool === "run_command") {
    const command = String(args.command ?? "");
    if (!command.trim()) return { ok: false, error: "command is required" };
    if (isDestructiveCommand(command)) {
      return { ok: false, error: "Destructive command requires ToolGateway approval and was not executed by the worker directly." };
    }
    const kind = /\b(dev|start|serve|watch|preview)\b/i.test(command) ? "service" as const : "command" as const;
    if (kind === "service") {
      const existing = processTracker.findRunningService(root, command);
      if (existing) {
        return { ok: true, output: `Already running ${existing.processId} on ${existing.port ? `port ${existing.port}` : "an existing port"}` };
      }
      const started = processTracker.start({
        command: process.platform === "win32" ? normalizeWindowsCommand(command) : command,
        cwd: root,
        projectRoot: root,
        runId: req.runId,
        kind,
        onOutput: req.onOutput,
      });
      return { ok: true, output: `Started service ${started.processId}: ${command}` };
    }
    return tools.terminal.execute({ command });
  }

  if (req.tool === "start_dev_server") {
    const command = String(args.command ?? "npm run dev");
    const existing = processTracker.findRunningService(root, command);
    if (existing) return { ok: true, output: `Dev server already running (${existing.processId}${existing.port ? ` :${existing.port}` : ""})` };
    const started = processTracker.start({ command, cwd: root, projectRoot: root, runId: req.runId, kind: "service", onOutput: req.onOutput });
    return { ok: true, output: `Started ${started.processId}: ${command}` };
  }

  if (req.tool === "stop_process") {
    return processTracker.stop(String(args.processId ?? args.id ?? ""), { runId: req.runId });
  }
  if (req.tool === "process_status" || req.tool === "list_processes") {
    return { ok: true, output: JSON.stringify(processTracker.list(root), null, 2) };
  }
  if (req.tool === "read_process_logs") {
    return { ok: true, output: processTracker.logs(String(args.processId ?? args.id ?? "")) || "(no logs)" };
  }

  const tool = tools[req.tool];
  if (!tool) return { ok: false, error: `Unknown local tool: ${req.tool}` };
  return tool.execute(args);
}

export async function assertWorkspaceFile(projectRoot: string, relativePath: string): Promise<string> {
  const resolved = await resolveSafeRealpath(projectRoot, relativePath);
  return resolved;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function bindTools(projectRoot: string, tenantId: string): Record<string, { execute: (args: Record<string, unknown>) => Promise<ToolResult> }> {
  return {
    read_file: makeReadFileTool(projectRoot),
    write_file: makeWriteFileTool(projectRoot),
    edit_file: makeEditFileTool(projectRoot),
    list_directory: makeListDirectoryTool(projectRoot),
    search_files: makeSearchFilesTool(projectRoot),
    search_code: makeSearchCodeTool(projectRoot),
    delete_file: makeDeleteFileTool(projectRoot),
    terminal: makeTerminalTool(projectRoot),
    run_command: makeTerminalTool(projectRoot),
    run_tests: makeRunTestsTool(projectRoot),
    run_build: { execute: (args) => makeTerminalTool(projectRoot).execute({ command: String(args.command ?? "npm run build") }) },
    run_typecheck: makeRunTypecheckTool(projectRoot),
    git_status: makeGitStatusTool(projectRoot),
    git_diff: makeGitDiffTool(projectRoot),
    git_log: makeGitLogTool(projectRoot),
    git_branch: makeGitBranchTool(projectRoot),
    git_checkout: makeGitCheckoutTool(projectRoot),
    git_commit: makeGitCommitTool(projectRoot),
    search_codebase: makeSearchCodeTool(projectRoot),
    host_desktop_status: makeHostDesktopStatusTool(tenantId),
    host_desktop_screenshot: makeHostDesktopScreenshotTool(tenantId),
    host_desktop_move: makeHostDesktopMoveTool(tenantId),
    host_desktop_click: makeHostDesktopClickTool(tenantId),
    host_desktop_type: makeHostDesktopTypeTool(tenantId),
    host_desktop_scroll: makeHostDesktopScrollTool(tenantId),
    host_desktop_focus: makeHostDesktopFocusTool(tenantId),
  };
}
