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
      return new Promise((resolve) => {
        exec(command, { cwd: projectRoot, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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
