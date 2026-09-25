// apps/backend/src/ai/tools/terminalTool.ts
import { spawn } from "child_process";
import { AITool, ToolResult } from "../ToolTypes";
import { isServiceCommand, runService } from "../../services/ServiceManager";

// Per the master spec, ALL terminal access requires approval — this is not
// configurable to "allowed". Certain patterns are additionally flagged as
// destructive so the UI can render a stronger warning before approval.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\bformat\b/i,
  /drop\s+database/i,
  /git\s+reset\s+--hard/i,
  /git\s+push\s+--force/i,
  /:\(\)\{.*\}:/, // fork bomb shape
];

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

/**
 * Models habitually emit Unix-shell syntax; on Windows the terminal executes
 * through cmd.exe, where `/c/laragon/...` and `2>/dev/null` die with
 * "The system cannot find the path specified." (reproduced live on a mission
 * against C:/laragon/www/virphone). Translating the two POSIX-isms cmd cannot
 * survive keeps the agent self-sufficient instead of failing on paths.
 */
export function normalizeWindowsCommand(command: string): string {
  let out = command;
  // /c/foo/bar → C:/foo/bar (single drive letter between slashes, preceded by
  // a shell boundary — never inside URLs like http:// or cmd flags like /b).
  out = out.replace(/(^|[\s(&|;])\/([a-zA-Z])\//g, (_m, lead: string, drive: string) => `${lead}${drive.toUpperCase() }:/`);
  // /dev/null redirects → the NUL device.
  out = out.replace(/\s*\/dev\/null/g, "NUL").replace(/(\d?)>\s*NUL/g, "$1>NUL");
  return out;
}

/**
 * One-shot commands (npm install, a scaffolder, a test suite) get minutes,
 * not seconds: output streams to the chat while they work. Servers never hit
 * this: they are handed to ServiceManager and return once they listen.
 */
const TERMINAL_TIMEOUT_MS = Number(process.env.ORVYN_TERMINAL_TIMEOUT_MS) > 0 ? Number(process.env.ORVYN_TERMINAL_TIMEOUT_MS) : 5 * 60_000;
const MAX_CAPTURE = 1024 * 1024;

/**
 * Runs a shell command and streams its output as it is printed, so the chat
 * can show "npm test" working instead of a silent row that jumps to Done.
 * Same result shape as before: ok on exit 0, otherwise the error text.
 */
export function runStreaming(
  command: string,
  cwd: string,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
  timeoutMs = TERMINAL_TIMEOUT_MS,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    // No stdin: a scaffolder that would wait for an answer sees a
    // non-interactive shell and uses its defaults instead of hanging. CI=1
    // keeps test runners (vitest, jest) from entering watch mode.
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: process.env.CI ?? "1" },
    });
    const take = (which: "out" | "err") => (d: Buffer) => {
      const text = d.toString();
      if (which === "out") { if (stdout.length < MAX_CAPTURE) stdout += text; }
      else if (stderr.length < MAX_CAPTURE) stderr += text;
      try { onOutput?.(text); } catch { /* a viewer must never break the command */ }
    };
    child.stdout?.on("data", take("out"));
    child.stderr?.on("data", take("err"));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (err) => finish({ ok: false, error: err.message, output: stdout }));
    child.on("close", (code) => {
      if (code === 0 && !timedOut) return finish({ ok: true, output: stdout || stderr });
      const reason = timedOut
        ? `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`
        : `Command failed (exit ${code ?? "killed"}): ${command}`;
      finish({ ok: false, error: stderr || reason, output: stdout });
    });
  });
}

export function makeTerminalTool(projectRoot: string): AITool {
  return {
    name: "terminal",
    description: "Run a shell command in the project directory. Always requires user approval.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      const command = String(args.command);
      if (/\btaskkill\b/i.test(command) && /\bnode(\.exe)?\b/i.test(command)) {
        return { ok: false, error: "Refusing to kill every node process. That stops ORVYN itself. Stop the one server by its port." };
      }
      const finalCommand = process.platform === "win32" ? normalizeWindowsCommand(command) : command;
      // A dev server never "finishes". It becomes a service that outlives the run.
      if (isServiceCommand(finalCommand)) {
        const { result } = await runService({ command: finalCommand, cwd: projectRoot, projectRoot, onOutput: context?.onOutput, readyTimeoutMs: 90_000 });
        return result;
      }
      return runStreaming(finalCommand, projectRoot, context?.onOutput, context?.signal);
    },
  };
}
