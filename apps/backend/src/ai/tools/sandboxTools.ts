// apps/backend/src/ai/tools/sandboxTools.ts
//
// Sandbox-backed command-class tools. In sandbox mode
// (ORVYN_MISSION_EXECUTION=sandbox) the runtime swaps these in for the
// host-side equivalents, so project code executes inside the mission's
// isolated container instead of on the API host:
//
//   terminal / run_command   → execStructured (cwd resolved by the provider)
//   run_tests                → detected runner, executed inside the sandbox
//   run_typecheck            → npx tsc --noEmit inside the sandbox
//   run_linter               → package.json lint script inside the sandbox
//   start_process …          → provider-native background processes
//
// Detection for the semantic tools reads the HOST project tree — that is the
// authoritative tree (file tools write there). Execution happens inside the
// sandbox against its synced copy; the runtime refreshes the copy before a
// verification run so a just-written fix is actually what gets checked.
//
// ssh_exec stays host-side by design (remote administration of allow-listed
// servers is its own feature, not project code execution).

import { promises as fs } from "fs";
import * as path from "path";
import { AITool, ToolResult, type ToolOutputChunk } from "../ToolTypes";

/** One command executed inside the sandbox. `cwd` is workspace-RELATIVE and already validated. */
export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  timeoutS?: number;
  signal?: AbortSignal;
  /** Combined-stream callback (legacy shape). */
  onOutput?: (chunk: string) => void;
  /** Structured stream callback — the provider separates stdout and stderr. */
  onOutputChunk?: (chunk: ToolOutputChunk) => void;
}

export interface SandboxExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Combined stdout+stderr — what existing callers print. */
  output: string;
  exitCode: number;
  timedOut: boolean;
}

/** A provider-native background process inside the sandbox (dev server, watcher). */
export interface SandboxProcess {
  id: string;
  command: string;
  /** Workspace-relative cwd the process was started in. */
  cwd: string;
  pid?: number;
  startedAt: number;
  status: "running" | "exited" | "failed" | "stopped";
  exitCode?: number;
}

/**
 * The execution seam a sandboxed command tool needs — satisfied by
 * DockerSandbox today; an OpenShell (or future MicroVM) provider implements
 * the same shape, so the runtime never binds to a vendor class.
 *
 * `exec` is the minimal legacy surface. Providers SHOULD implement
 * `execStructured` — it takes a validated workspace-relative cwd the provider
 * resolves natively (docker -w, microVM workdir) and separates stdout/stderr.
 * The process-lifecycle methods are optional; the tools degrade to
 * CAPABILITY_UNAVAILABLE when a provider lacks them.
 */
export interface SandboxExec {
  exec(
    command: string,
    opts?: { timeoutS?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }
  ): Promise<{ ok: boolean; output: string; exitCode: number; timedOut: boolean; stdout?: string; stderr?: string }>;
  execStructured?(req: SandboxExecRequest): Promise<SandboxExecResult>;
  startProcess?(req: { command: string; cwd?: string }): Promise<SandboxProcess>;
  stopProcess?(id: string): Promise<{ ok: boolean; error?: string }>;
  processLogs?(id: string, tail?: number): Promise<{ stdout: string; stderr: string }>;
  listProcesses?(): Promise<SandboxProcess[]>;
}

/**
 * Normalize a requested cwd into a path strictly beneath /workspace.
 * Returns "" for the root, null when the request would escape
 * (absolute paths, `..` segments, `~`, encoded traversal, or empty-after-strip garbage).
 */
export function sandboxCwd(raw: unknown): string | null {
  let cleaned = String(raw ?? "").trim();
  // Percent-encoded traversal (%2e%2e, %2f) must not smuggle a `..` through.
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    return null; // malformed escape — refuse rather than guess
  }
  cleaned = cleaned.replace(/\0/g, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned) return "";
  // Absolute paths are not workspace-relative — refuse rather than silently
  // relativize a request the model meant to point somewhere else.
  if (cleaned.startsWith("/") || cleaned.startsWith("~") || /^[a-zA-Z]:\//.test(cleaned) || cleaned.startsWith("//")) return null;
  const segments = cleaned.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === ".." || s === "~")) return null;
  return segments.join("/");
}

const MAX_ERROR_OUTPUT = 4_000;

/**
 * Run one command in the sandbox. Prefers the provider's structured surface
 * (native cwd resolution + split streams); falls back to the legacy exec()
 * with the cwd composed into the command for providers that only implement
 * the minimal seam.
 */
async function runSandbox(sandbox: SandboxExec, req: SandboxExecRequest): Promise<SandboxExecResult> {
  if (sandbox.execStructured) return sandbox.execStructured(req);
  const full = req.cwd ? `cd /workspace/${req.cwd} && (${req.command})` : `cd /workspace && (${req.command})`;
  const r = await sandbox.exec(full, {
    timeoutS: req.timeoutS,
    signal: req.signal,
    onOutput: req.onOutput ?? (req.onOutputChunk ? (chunk) => req.onOutputChunk!({ stream: "stdout", data: chunk }) : undefined),
  });
  return {
    ok: r.ok,
    stdout: r.stdout ?? r.output,
    stderr: r.stderr ?? "",
    output: r.output,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
  };
}

/** Map a sandbox result onto the shared ToolResult failure contract. */
function execResultToTool(result: SandboxExecResult, prefix?: string): ToolResult {
  if (result.timedOut) {
    return {
      ok: false,
      error: `${prefix ? `${prefix} ` : ""}timed out and was killed inside the sandbox. Output so far:\n${result.output.slice(0, MAX_ERROR_OUTPUT)}`,
      errorType: "TIMEOUT",
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      error: `${prefix ? `${prefix} ` : ""}exited with code ${result.exitCode}: ${result.output.slice(0, MAX_ERROR_OUTPUT)}`,
      errorType: "EXECUTION_FAILED",
    };
  }
  return { ok: true, output: result.output };
}

export function makeSandboxTerminalTool(sandbox: SandboxExec): AITool {
  return {
    name: "terminal",
    description:
      "Run a shell command inside the mission's isolated execution sandbox (no network, resource-limited). The project files are in /workspace. Always requires user approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Subdirectory of /workspace to run in (optional)" },
      },
      required: ["command"],
    },
    // Matches the host terminal tool: every call asks.
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      const command = String(args.command ?? "").trim();
      if (!command) return { ok: false, error: "command is required", errorType: "INVALID_ARGUMENTS" };

      const cwd = sandboxCwd(args.cwd);
      if (cwd === null) {
        return {
          ok: false,
          error: `cwd "${String(args.cwd ?? "")}" escapes the workspace — supply a subdirectory of /workspace.`,
          errorType: "INVALID_ARGUMENTS",
        };
      }
      const result = await runSandbox(sandbox, {
        command,
        cwd,
        signal: context?.signal,
        onOutput: context?.onOutput,
        onOutputChunk: context?.onOutputChunk,
      });
      return execResultToTool(result, "Command");
    },
  };
}

// ── Semantic verification tools ─────────────────────────────────────────────

const VERIFY_TIMEOUT_S = 5 * 60;

async function hostFileExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectRoot, rel));
    return true;
  } catch {
    return false;
  }
}

async function hostPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    return JSON.parse(raw).scripts ?? {};
  } catch {
    return {};
  }
}

function clip(s: string, max = 20_000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

/**
 * run_tests / run_typecheck / run_linter, executed inside the sandbox.
 *
 * Runner DETECTION reads the host tree (the authoritative copy the file tools
 * write); the detected command EXECUTES in the sandbox. `opts.beforeRun`
 * refreshes the sandbox copy first, so verification covers the files the
 * mission just wrote rather than the stale start-of-mission snapshot.
 */
export function makeSandboxVerificationTools(
  sandbox: SandboxExec,
  projectRoot: string,
  opts: { beforeRun?: () => Promise<void> | void } = {}
): AITool[] {
  const runVerification = async (command: string, context: Parameters<AITool["execute"]>[1]): Promise<{ code: number; text: string }> => {
    await Promise.resolve(opts.beforeRun?.()).catch(() => {});
    const result = await runSandbox(sandbox, {
      command,
      cwd: "",
      timeoutS: VERIFY_TIMEOUT_S,
      signal: context?.signal,
      onOutput: context?.onOutput,
      onOutputChunk: context?.onOutputChunk,
    });
    const text = clip([result.stdout, result.stderr].filter((s) => s.trim()).join("\n").trim() || result.output);
    return { code: result.timedOut ? -1 : result.exitCode, text };
  };

  const typecheck = async (args: Record<string, unknown>, context: Parameters<AITool["execute"]>[1]): Promise<ToolResult> => {
    const project = args.project ? sandboxCwd(args.project) : "";
    if (project === null) {
      return { ok: false, error: `project "${String(args.project ?? "")}" escapes the workspace.`, errorType: "INVALID_ARGUMENTS" };
    }
    if (!(await hostFileExists(projectRoot, path.posix.join(project || ".", "tsconfig.json")))) {
      return {
        ok: false,
        error: `Not applicable: no tsconfig.json at /workspace/${project || "."} — this project has no TypeScript to check. Do not add TypeScript, a tsconfig.json or a package.json unless the user asked for them.`,
        errorType: "RESOURCE_MISSING",
      };
    }
    const cmd = project ? `npx tsc --noEmit -p "${project}"` : "npx tsc --noEmit";
    const { code, text } = await runVerification(cmd, context);
    if (code === 0) return { ok: true, output: "Typecheck passed: no errors." };
    return { ok: true, output: clip(`Typecheck found problems (exit ${code}):\n${text}`) };
  };

  return [
    {
      name: "run_tests",
      description:
        "Run the project's test suite inside the mission sandbox (package.json `test` script, or pytest for a Python project). Optional filter narrows to matching tests.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "Test name/path filter passed to the runner (optional)" } },
      },
      defaultPermission: "ask",
      async execute(args, context): Promise<ToolResult> {
        const scripts = await hostPackageScripts(projectRoot);
        const filter = args.filter ? String(args.filter).replace(/["`$\\]/g, "") : "";
        let cmd: string | null = null;
        if (scripts.test && !/no test specified/i.test(scripts.test)) {
          cmd = filter ? `npm test -- "${filter}"` : "npm test";
        } else if ((await hostFileExists(projectRoot, "pytest.ini")) || (await hostFileExists(projectRoot, "pyproject.toml"))) {
          cmd = filter ? `python -m pytest -k "${filter}"` : "python -m pytest";
        }
        if (!cmd) {
          return {
            ok: false,
            error: "Not applicable: no test runner found (package.json has no real `test` script and no pytest config exists). Do not add a test setup unless the user asked for one.",
            errorType: "RESOURCE_MISSING",
          };
        }
        const { code, text } = await runVerification(cmd, context);
        const report = `$ ${cmd}\nexit ${code}\n\n${text}`;
        // A failing suite is a failed tool call — a red run is not "verified".
        if (code !== 0) return { ok: false, error: `Tests failed in the sandbox (exit ${code}).\n\n${report}`, output: report, errorType: code === -1 ? "TIMEOUT" : "EXECUTION_FAILED" };
        return { ok: true, output: report };
      },
    },
    {
      name: "run_typecheck",
      description: "Run the TypeScript compiler in check mode inside the mission sandbox (alias of get_diagnostics semantics).",
      parameters: {
        type: "object",
        properties: { project: { type: "string", description: "Subfolder with the tsconfig.json to check (optional)" } },
      },
      defaultPermission: "ask",
      execute: (args, context) => typecheck(args, context),
    },
    {
      name: "get_diagnostics",
      description:
        "Project-wide compiler diagnostics inside the mission sandbox (TypeScript: tsc --noEmit). Optional `project` = subfolder containing a tsconfig.",
      parameters: {
        type: "object",
        properties: { project: { type: "string", description: "Subfolder with the tsconfig.json to check (optional)" } },
      },
      defaultPermission: "allowed",
      execute: (args, context) => typecheck(args, context),
    },
    {
      name: "run_linter",
      description: "Run the project's linter inside the mission sandbox (package.json `lint` script). Reports problems; never auto-fixes.",
      parameters: { type: "object", properties: {} },
      defaultPermission: "ask",
      async execute(_args, context): Promise<ToolResult> {
        const scripts = await hostPackageScripts(projectRoot);
        if (!scripts.lint) {
          return {
            ok: false,
            error: "Not applicable: no `lint` script in package.json, so there is no linter to run. Do not add one unless the user asked for it.",
            errorType: "RESOURCE_MISSING",
          };
        }
        const { code, text } = await runVerification("npm run lint", context);
        return { ok: true, output: `$ npm run lint\nexit ${code}\n\n${text}` };
      },
    },
  ];
}

// ── Sandbox-native process lifecycle ─────────────────────────────────────────

const unavailable = (capability: string): ToolResult => ({
  ok: false,
  error: `${capability} is not supported by this sandbox provider. Use the terminal tool for one-shot commands.`,
  errorType: "CAPABILITY_UNAVAILABLE",
});

/**
 * start_process / stop_process / read_process_logs / list_processes against
 * the provider's own process surface. Only registers names the provider
 * actually implements — a provider missing the surface leaves the host tools
 * in place only if the runtime chooses to keep them.
 */
export function makeSandboxProcessTools(sandbox: SandboxExec): AITool[] {
  const tools: AITool[] = [];

  tools.push({
    name: "start_process",
    description:
      "Start a long-running process (dev server, watcher) inside the mission sandbox. It keeps running for the mission's duration. Use terminal for one-shot commands.",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string", description: "Subdirectory of /workspace (optional)" } }, required: ["command"] },
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      if (!sandbox.startProcess) return unavailable("Background processes");
      const command = String(args.command ?? "").trim();
      if (!command) return { ok: false, error: "command is required", errorType: "INVALID_ARGUMENTS" };
      const cwd = sandboxCwd(args.cwd);
      if (cwd === null) return { ok: false, error: `cwd "${String(args.cwd ?? "")}" escapes the workspace.`, errorType: "INVALID_ARGUMENTS" };
      if (context?.signal?.aborted) return { ok: false, error: "Stopped by user", errorType: "UNKNOWN" };
      const proc = await sandbox.startProcess({ command, cwd });
      if (proc.status === "failed") {
        return { ok: false, error: `Process failed to start in the sandbox: ${command}`, errorType: "EXECUTION_FAILED" };
      }
      return {
        ok: true,
        output: `Started ${proc.id} inside the sandbox${proc.pid ? ` (pid ${proc.pid})` : ""}: ${proc.command}\nIt runs until stopped (stop_process) or the mission sandbox is torn down.`,
        meta: { processId: proc.id, pid: proc.pid },
      };
    },
  });

  tools.push({
    name: "stop_process",
    description: "Stop a process started with start_process inside the mission sandbox.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      if (!sandbox.stopProcess) return unavailable("Stopping sandbox processes");
      const id = String(args.id ?? args.processId ?? "");
      if (!id) return { ok: false, error: "id is required", errorType: "INVALID_ARGUMENTS" };
      const result = await sandbox.stopProcess(id);
      if (!result.ok) return { ok: false, error: result.error ?? `Unknown sandbox process "${id}"`, errorType: "RESOURCE_MISSING" };
      return { ok: true, output: `Stopped ${id}.` };
    },
  });

  tools.push({
    name: "read_process_logs",
    description: "Read the recent output of a sandbox process (default: last 80 lines).",
    parameters: { type: "object", properties: { id: { type: "string" }, tail: { type: "number", description: "How many trailing lines (default 80)" } }, required: ["id"] },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      if (!sandbox.processLogs) return unavailable("Reading sandbox process logs");
      const id = String(args.id ?? args.processId ?? "");
      if (!id) return { ok: false, error: "id is required", errorType: "INVALID_ARGUMENTS" };
      const tail = Math.min(Math.max(Number(args.tail) || 80, 1), 500);
      try {
        const logs = await sandbox.processLogs(id, tail);
        const parts = [logs.stdout, logs.stderr && `stderr:\n${logs.stderr}`].filter(Boolean);
        return { ok: true, output: parts.join("\n\n") || "(no output yet)" };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err), errorType: "RESOURCE_MISSING" };
      }
    },
  });

  tools.push({
    name: "list_processes",
    description: "List the processes running inside the mission sandbox and their status.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    async execute(): Promise<ToolResult> {
      if (!sandbox.listProcesses) return unavailable("Listing sandbox processes");
      const rows = await sandbox.listProcesses();
      if (!rows.length) return { ok: true, output: "(no sandbox processes)" };
      return {
        ok: true,
        output: rows
          .map((p) => `${p.id}: ${p.command} — ${p.status}${p.exitCode != null ? ` (exit ${p.exitCode})` : ""} (started ${Math.round((Date.now() - p.startedAt) / 1000)}s ago)`)
          .join("\n"),
      };
    },
  });

  return tools;
}

/**
 * Command-class tools with NO sandbox-backed equivalent. Anything listed here
 * is denied for the mission's duration — the semantic and process tools above
 * cover their ground inside the sandbox. Kept as the migration list: when a
 * provider cannot implement a capability, its name goes back in this list.
 */
export const SANDBOX_DENIED_TOOLS: string[] = [];

export function sandboxDenialMessage(tool: string): string {
  return `Tool "${tool}" is disabled in sandbox mode — it executes project code on the host. Run the equivalent command with the terminal tool instead: it executes inside the mission's isolated sandbox.`;
}
