// apps/backend/src/ai/tools/terminalTool.ts
import { exec } from "child_process";
import { AITool, ToolResult } from "../ToolTypes";

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
    async execute(args): Promise<ToolResult> {
      const command = String(args.command);
      const finalCommand = process.platform === "win32" ? normalizeWindowsCommand(command) : command;
      return new Promise((resolve) => {
        exec(finalCommand, { cwd: projectRoot, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, error: stderr || error.message, output: stdout });
          } else {
            resolve({ ok: true, output: stdout || stderr });
          }
        });
      });
    },
  };
}
