// apps/backend/src/ai/tools/gitTools.ts
import { execFile } from "child_process";
import { AITool, ToolResult } from "../ToolTypes";

function runGit(projectRoot: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: stderr || error.message });
      else resolve({ ok: true, output: stdout || "(no output)" });
    });
  });
}

export function makeGitStatusTool(projectRoot: string): AITool {
  return {
    name: "git_status",
    description: "Show the working tree status (git status --short).",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed", // read-only, cannot mutate the repo
    execute: () => runGit(projectRoot, ["status", "--short"]),
  };
}

export function makeGitDiffTool(projectRoot: string): AITool {
  return {
    name: "git_diff",
    description: "Show unstaged changes (git diff).",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: () => runGit(projectRoot, ["diff"]),
  };
}

// Commits mutate history, so — unlike status/diff — this requires approval,
// matching the master spec's permission table.
export function makeGitCommitTool(projectRoot: string): AITool {
  return {
    name: "git_commit",
    description: "Stage all changes and commit with a message. Requires approval.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      const addResult = await runGit(projectRoot, ["add", "-A"]);
      if (!addResult.ok) return addResult;
      return runGit(projectRoot, ["commit", "-m", String(args.message)]);
    },
  };
}
