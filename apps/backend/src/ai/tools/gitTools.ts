// apps/backend/src/ai/tools/gitTools.ts
import { execFile } from "child_process";
import { AITool, ToolResult } from "../ToolTypes";
import { workspaceRootFor } from "../../execution/workspaceBinding";
import { resolveSafePath } from "../../execution/pathSafety";
import { formatGitStatus, notARepository, parseGitStatusPorcelain } from "./gitStatus";

function runGit(projectRoot: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: stderr || error.message });
      else resolve({ ok: true, output: stdout || "(no output)" });
    });
  });
}

function gitStatusLog(event: "git.status.start" | "git.status.complete" | "git.status.error", extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

export function makeGitStatusTool(projectRoot: string): AITool {
  return {
    name: "git_status",
    description: "Show the working tree status. Returns branch, clean, modified, staged, and untracked.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed", // read-only, cannot mutate the repo
    execute: (_args, context) => {
      const root = workspaceRootFor(projectRoot, context);
      gitStatusLog("git.status.start");
      return new Promise((resolve) => {
        execFile("git", ["status", "--porcelain=v1", "-b"], { cwd: root, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const text = `${stdout || ""}\n${stderr || ""}`;
          if (error && /not a git repository/i.test(text + (error.message || ""))) {
            const snapshot = notARepository();
            gitStatusLog("git.status.complete", { repository: false, clean: true });
            resolve({ ok: true, output: formatGitStatus(snapshot), meta: { gitStatus: snapshot } });
            return;
          }
          if (error) {
            gitStatusLog("git.status.error", { message: (stderr || error.message).slice(0, 200) });
            resolve({ ok: false, error: stderr || error.message });
            return;
          }
          const snapshot = parseGitStatusPorcelain(stdout || "");
          gitStatusLog("git.status.complete", { repository: true, clean: snapshot.clean, branch: snapshot.branch });
          resolve({ ok: true, output: formatGitStatus(snapshot), meta: { gitStatus: snapshot } });
        });
      });
    },
  };
}

export function makeGitDiffTool(projectRoot: string): AITool {
  return {
    name: "git_diff",
    description: "Show unstaged changes (git diff).",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: (_args, context) => runGit(workspaceRootFor(projectRoot, context), ["diff"]),
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
    execute: (args, context) => {
      const root = workspaceRootFor(projectRoot, context);
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const gitArgs = ["log", "--oneline", "--decorate", `-n${limit}`];
      if (args.path) gitArgs.push("--", resolveSafePath(root, String(args.path)));
      return runGit(root, gitArgs);
    },
  };
}

export function makeGitBranchTool(projectRoot: string): AITool {
  return {
    name: "git_branch",
    description: "List branches (git branch -a) with the current one marked.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: (_args, context) => runGit(workspaceRootFor(projectRoot, context), ["branch", "-a", "--no-color"]),
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
    execute: (args, context) => {
      const branch = String(args.branch ?? "").trim();
      // Refuse anything that isn't a plain branch name; "git checkout -- ." or
      // pathspecs would silently discard local work.
      if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) {
        return Promise.resolve({ ok: false, error: `Invalid branch name "${branch}"` });
      }
      const gitArgs = args.create === true ? ["checkout", "-b", branch] : ["checkout", branch];
      return runGit(workspaceRootFor(projectRoot, context), gitArgs);
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
    async execute(args, context): Promise<ToolResult> {
      const root = workspaceRootFor(projectRoot, context);
      const addResult = await runGit(root, ["add", "-A"]);
      if (!addResult.ok) return addResult;
      return runGit(root, ["commit", "-m", String(args.message)]);
    },
  };
}
