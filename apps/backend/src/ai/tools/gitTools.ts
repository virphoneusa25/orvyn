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

export function makeGitLogTool(projectRoot: string): AITool {
  return {
    name: "git_log",
    description: "Show recent commit history (git log --oneline). Optional: limit (default 20), path.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max commits to show (default 20)" },
        path: { type: "string", description: "Only commits touching this path" },
      },
    },
    defaultPermission: "allowed",
    execute: (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const gitArgs = ["log", "--oneline", "--decorate", `-n${limit}`];
      if (args.path) gitArgs.push("--", String(args.path));
      return runGit(projectRoot, gitArgs);
    },
  };
}

export function makeGitBranchTool(projectRoot: string): AITool {
  return {
    name: "git_branch",
    description: "List branches (git branch -a) with the current one marked.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: () => runGit(projectRoot, ["branch", "-a", "--no-color"]),
  };
}

// Checkout moves the working tree, so it needs approval like other mutations.
export function makeGitCheckoutTool(projectRoot: string): AITool {
  return {
    name: "git_checkout",
    description:
      "Switch to a branch, or create one with create=true. Requires approval — it changes the working tree. Never used for discarding files.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string" },
        create: { type: "boolean", description: "Create the branch first (git checkout -b)" },
      },
      required: ["branch"],
    },
    defaultPermission: "ask",
    execute: (args) => {
      const branch = String(args.branch ?? "").trim();
      // Refuse anything that isn't a plain branch name; "git checkout -- ." or
      // pathspecs would silently discard local work.
      if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) {
        return Promise.resolve({ ok: false, error: `Invalid branch name "${branch}"` });
      }
      const gitArgs = args.create === true ? ["checkout", "-b", branch] : ["checkout", branch];
      return runGit(projectRoot, gitArgs);
    },
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
