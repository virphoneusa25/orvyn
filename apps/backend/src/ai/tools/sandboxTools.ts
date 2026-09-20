// apps/backend/src/ai/tools/sandboxTools.ts
//
// Sandbox-backed replacements for the command-class tools. In sandbox mode
// (ORVYN_MISSION_EXECUTION=sandbox) the runtime swaps these in for
// terminal/run_command, so project code executes inside the mission's Docker
// container instead of on the API host.
//
// In sandbox mode the fixed-command verification tools (run_tests,
// run_typecheck, run_linter) and process tools are DENIED outright: they also
// execute project code, and "use the terminal inside the sandbox" is the one
// honest path. ssh_exec stays host-side by design (remote administration of
// allow-listed servers is its own feature, not project code execution).

import { AITool, ToolResult } from "../ToolTypes";
import { DockerSandbox } from "../../sandbox/DockerSandbox";

export function makeSandboxTerminalTool(sandbox: DockerSandbox): AITool {
  return {
    name: "terminal",
    description:
      "Run a shell command inside the mission's isolated Docker sandbox (no network, resource-limited). The project files are in /workspace. Always requires user approval.",
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
      if (!command) return { ok: false, error: "command is required" };

      const cwd = String(args.cwd ?? "").trim();
      const full = cwd ? `cd /workspace/${cwd.replace(/^\/+/, "")} && (${command})` : `cd /workspace && (${command})`;

      const result = await sandbox.exec(full, { signal: context?.signal, onOutput: context?.onOutput });
      if (result.timedOut) {
        return { ok: false, error: `Command timed out and was killed inside the sandbox. Output so far:\n${result.output.slice(0, 4000)}` };
      }
      if (!result.ok) {
        return { ok: false, error: `exit code ${result.exitCode}: ${result.output.slice(0, 4000)}` };
      }
      return { ok: true, output: result.output };
    },
  };
}

/**
 * Tools that must NOT run on the host while a mission is sandboxed. The
 * runtime denies these for the mission's duration; each denial message tells
 * the agent the sandbox path instead of leaving it guessing.
 */
export const SANDBOX_DENIED_TOOLS: string[] = [
  "run_tests",
  "run_typecheck",
  "run_linter",
  "start_process",
  "stop_process",
];

export function sandboxDenialMessage(tool: string): string {
  return `Tool "${tool}" is disabled in sandbox mode — it executes project code on the host. Run the equivalent command with the terminal tool instead: it executes inside the mission's isolated sandbox.`;
}
