// apps/backend/src/execution/VercelExecutionProvider.ts
// Managed Vercel Sandbox execution behind ORVYN Cloud.

import { execFile } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { CommandResult, ExecutionProvider } from "./ExecutionProvider";

const WORKSPACE = "/vercel/sandbox/workspace";
const UPLOAD = "/vercel/sandbox/orvyn-workspace.tar";
// Preserve .git so ORION's existing git_status/diff/log/branch/commit
// tools operate on the real repository inside the cloud microVM. Large repos
// should move to direct Git clone hydration in the next optimization phase.
const EXCLUDES = ["node_modules", ".orvyn", "dist", "release", ".cache"];
const DELETE_PROTECTED_PREFIXES = [".git"];
const MAX_SYNC_MB = Number(process.env.ORVYN_VERCEL_SYNC_MAX_MB) || 64;

export interface VercelWorkspaceIdentity {
  tenantId: string;
  workspaceId: string;
  projectId?: string | null;
}

type Entry = {
  sandbox: any;
  sandboxId: string;
  sandboxName?: string;
  projectRoot: string;
  cancelled: boolean;
  persistent: boolean;
};

export function vercelSandboxName(identity: VercelWorkspaceIdentity): string {
  const digest = createHash("sha256")
    .update(
      [identity.tenantId, identity.workspaceId, identity.projectId ?? ""].join("\n")
    )
    .digest("hex")
    .slice(0, 24);
  return "orvyn-ws-" + digest;
}

function persistentWorkspacesEnabled(identity?: VercelWorkspaceIdentity): boolean {
  if (!identity?.tenantId?.trim() || !identity.workspaceId?.trim()) return false;
  const raw = String(process.env.ORVYN_VERCEL_PERSISTENT_WORKSPACES ?? "true")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function credentials():
  | { mode: "oidc"; createOptions: Record<string, never> }
  | {
      mode: "access-token";
      createOptions: { token: string; teamId: string; projectId: string };
    }
  | null {
  // Vercel injects OIDC automatically into production runtimes. In that
  // environment the SDK authenticates without explicit token/team/project
  // arguments, so ORVYN does not need a long-lived Vercel token.
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) {
    return { mode: "oidc", createOptions: {} };
  }

  // External runtimes/CI use a team-scoped access token.
  const token =
    process.env.SANDBOX_VERCEL_TOKEN?.trim() ||
    process.env.VERCEL_TOKEN?.trim();
  const teamId =
    process.env.SANDBOX_VERCEL_TEAM_ID?.trim() ||
    process.env.VERCEL_TEAM_ID?.trim();
  const projectId =
    process.env.SANDBOX_VERCEL_PROJECT_ID?.trim() ||
    process.env.VERCEL_PROJECT_ID?.trim();

  return token && teamId && projectId
    ? {
        mode: "access-token",
        createOptions: { token, teamId, projectId },
      }
    : null;
}

function sh(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function localExec(file: string, args: string[], timeout = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
      if (err) return reject(new Error(file + ": " + String(stderr || err.message).slice(0, 1000)));
      resolve();
    });
  });
}

async function snapshot(projectRoot: string): Promise<{ dir: string; data: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-vercel-in-"));
  const archive = path.join(dir, "workspace.tar");
  try {
    const args = ["cf", archive];
    for (const name of EXCLUDES) args.push("--exclude", name);
    args.push("-C", projectRoot, ".");
    await localExec("tar", args);
    const data = await fs.readFile(archive);
    if (data.byteLength > MAX_SYNC_MB * 1024 * 1024) {
      throw new Error("Workspace exceeds ORVYN_VERCEL_SYNC_MAX_MB=" + MAX_SYNC_MB + "MB");
    }
    return { dir, data };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function output(result: any): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  if (typeof result?.stdout === "function") stdout = await result.stdout().catch(() => "");
  if (typeof result?.stderr === "function") stderr = await result.stderr().catch(() => "");
  return { stdout, stderr };
}

async function collectRelativeFiles(root: string, rel = ""): Promise<Set<string>> {
  const files = new Set<string>();
  const dir = rel ? path.join(root, ...rel.split("/")) : root;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (EXCLUDES.includes(item.name)) continue;
    const child = rel ? rel + "/" + item.name : item.name;
    if (item.isDirectory()) {
      const nested = await collectRelativeFiles(root, child);
      for (const name of nested) files.add(name);
    } else if (item.isFile()) {
      files.add(child);
    }
  }
  return files;
}

async function removeEmptyDirectories(root: string, rel = ""): Promise<void> {
  const dir = rel ? path.join(root, ...rel.split("/")) : root;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (!item.isDirectory() || EXCLUDES.includes(item.name)) continue;
    const child = rel ? rel + "/" + item.name : item.name;
    await removeEmptyDirectories(root, child);
    const childDir = path.join(root, ...child.split("/"));
    const remaining = await fs.readdir(childDir).catch(() => ["keep"]);
    if (remaining.length === 0) {
      await fs.rmdir(childDir).catch(() => undefined);
    }
  }
}

/**
 * Reconcile a downloaded Vercel workspace with the durable local project.
 * This intentionally removes files that existed before the run but were
 * deleted inside the sandbox; without this step ORION deletions silently
 * reappear after sync-back.
 */
export async function reconcileDownloadedWorkspace(
  projectRoot: string,
  extractedRoot: string
): Promise<string[]> {
  const before = await collectRelativeFiles(projectRoot);
  const after = await collectRelativeFiles(extractedRoot);

  for (const rel of before) {
    if (after.has(rel)) continue;
    if (
      DELETE_PROTECTED_PREFIXES.some(
        (prefix) => rel === prefix || rel.startsWith(prefix + "/")
      )
    ) {
      continue;
    }
    const target = path.join(projectRoot, ...rel.split("/"));
    await fs.rm(target, { force: true }).catch(() => undefined);
  }
  await removeEmptyDirectories(projectRoot);

  const copied: string[] = [];
  const walk = async (src: string, rel = ""): Promise<void> => {
    for (const item of await fs.readdir(src, { withFileTypes: true })) {
      if (EXCLUDES.includes(item.name)) continue;
      const child = rel ? rel + "/" + item.name : item.name;
      const from = path.join(src, item.name);
      const to = path.join(projectRoot, ...child.split("/"));
      if (item.isDirectory()) {
        const stat = await fs.lstat(to).catch(() => null);
        if (stat && !stat.isDirectory()) {
          await fs.rm(to, { recursive: true, force: true });
        }
        await fs.mkdir(to, { recursive: true });
        await walk(from, child);
      } else if (item.isFile()) {
        const stat = await fs.lstat(to).catch(() => null);
        if (stat?.isDirectory()) {
          await fs.rm(to, { recursive: true, force: true });
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
        copied.push(child);
      }
    }
  };

  await walk(extractedRoot);
  return copied;
}

export class VercelExecutionProvider implements ExecutionProvider {
  readonly location = "VERCEL_CLOUD" as const;
  private runs = new Map<string, Entry>();
  private handlers = new Map<string, (chunk: string) => void>();

  async startRun(
    runId: string,
    projectRoot: string,
    identity?: VercelWorkspaceIdentity
  ): Promise<void> {
    await this.stopRun(runId);
    const auth = credentials();
    if (!auth) {
      throw new Error(
        "Vercel Sandbox authentication is not configured. Use Vercel OIDC " +
          "when deployed on Vercel, or set token/team/project credentials."
      );
    }

    const mod = await import("@vercel/sandbox");
    const Sandbox = (mod.Sandbox as any);
    const ports = String(process.env.ORVYN_VERCEL_SANDBOX_PORTS || "3000,5173")
      .split(",").map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0);
    const persistent =
      persistentWorkspacesEnabled(identity) &&
      typeof Sandbox.getOrCreate === "function";
    const sandboxName = persistent && identity ? vercelSandboxName(identity) : undefined;
    const baseOptions = {
      ...auth.createOptions,
      image: "vercel/sandbox/universal:latest",
      timeout:
        (Number(process.env.ORVYN_SANDBOX_TIMEOUT_MIN) || 30) * 60000,
      ports,
      env: {
        ORVYN_EXECUTION_LOCATION: "VERCEL_CLOUD",
      },
    };

    // Named persistent sandboxes let ORVYN reuse expensive environment state
    // (browser packages, package caches, node_modules) across missions while
    // the canonical project is still re-hydrated from ORVYN before each run.
    // getOrCreate also recovers cleanly when an older snapshot has expired.
    const sandbox: any = persistent
      ? await Sandbox.getOrCreate({
          ...baseOptions,
          name: sandboxName,
          persistent: true,
        })
      : await Sandbox.create({
          ...baseOptions,
          persistent: false,
          env: {
            ...baseOptions.env,
            ORVYN_RUN_ID: runId,
          },
        });

    const sandboxId = String(sandbox.sandboxId ?? sandbox.id ?? runId);
    this.runs.set(runId, {
      sandbox,
      sandboxId,
      sandboxName,
      projectRoot,
      cancelled: false,
      persistent,
    });
    try {
      await this.uploadWorkspace(runId);
    } catch (err) {
      await this.stopRun(runId);
      throw err;
    }
  }

  async executeCommand(runId: string, command: string, opts: { timeoutS?: number; cwd?: string } = {}): Promise<CommandResult> {
    const entry = this.runs.get(runId);
    if (!entry) return { ok: false, output: "No Vercel Sandbox exists for this run.", exitCode: -1 };
    if (entry.cancelled) return { ok: false, output: "Run cancelled.", exitCode: -1 };

    const rel = String(opts.cwd ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (rel.split("/").includes("..")) return { ok: false, output: "cwd escapes the workspace.", exitCode: -1 };
    const cwd = rel ? WORKSPACE + "/" + rel : WORKSPACE;
    const timeoutS = Math.max(
      1,
      Math.floor(
        opts.timeoutS ??
          (Number(process.env.ORVYN_SANDBOX_COMMAND_TIMEOUT_S) || 300)
      )
    );

    try {
      const result = await entry.sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", "timeout --signal=KILL " + timeoutS + " sh -lc " + sh(command)],
        cwd,
      });
      const streams = await output(result);
      const exitCode = Number(result.exitCode ?? 1);
      const combined = [streams.stdout, streams.stderr].filter(Boolean).join("\n").trim() || "(no output)";
      this.handlers.get(runId)?.(combined);
      return { ok: exitCode === 0, output: combined, exitCode, timedOut: exitCode === 124 || exitCode === 137 };
    } catch (err: any) {
      return { ok: false, output: err?.message ?? String(err), exitCode: -1, timedOut: /timeout/i.test(err?.message ?? "") };
    }
  }

  onOutput(runId: string, cb: (chunk: string) => void): void {
    this.handlers.set(runId, cb);
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (entry) entry.cancelled = true;
    await this.stopRun(runId);
  }

  async uploadWorkspace(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error("No Vercel Sandbox exists for this run.");
    const snap = await snapshot(entry.projectRoot);
    try {
      await entry.sandbox.writeFiles([{ path: UPLOAD, content: snap.data }]);
      const reset = entry.persistent
        ? "mkdir -p " + sh(WORKSPACE) +
          " && find " + sh(WORKSPACE) +
          " -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +"
        : "rm -rf " + sh(WORKSPACE) + " && mkdir -p " + sh(WORKSPACE);
      const result = await entry.sandbox.runCommand({
        cmd: "sh",
        args: [
          "-lc",
          reset +
            " && tar xf " +
            sh(UPLOAD) +
            " --no-same-owner -C " +
            sh(WORKSPACE) +
            " && rm -f " +
            sh(UPLOAD),
        ],
      });
      if (Number(result.exitCode ?? 1) !== 0) {
        const streams = await output(result);
        throw new Error("Vercel workspace upload failed: " + streams.stderr);
      }
    } finally {
      await fs.rm(snap.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async downloadArtifacts(runId: string): Promise<{ files: string[] }> {
    const entry = this.runs.get(runId);
    if (!entry) return { files: [] };
    const excludes = EXCLUDES.map((name) => "--exclude=" + sh(name)).join(" ");
    const result = await entry.sandbox.runCommand({
      cmd: "sh",
      args: ["-lc", "tar cf /tmp/orvyn-out.tar " + excludes + " -C " + sh(WORKSPACE) + " . && base64 -w0 /tmp/orvyn-out.tar"],
    });
    if (Number(result.exitCode ?? 1) !== 0) throw new Error("Vercel workspace export failed");
    const streams = await output(result);
    const data = Buffer.from(streams.stdout.trim(), "base64");
    if (data.byteLength > MAX_SYNC_MB * 1024 * 1024) throw new Error("Vercel workspace export exceeds sync limit");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-vercel-out-"));
    const archive = path.join(dir, "workspace.tar");
    const extracted = path.join(dir, "workspace");
    const files: string[] = [];
    try {
      await fs.writeFile(archive, data);
      await fs.mkdir(extracted, { recursive: true });
      await localExec("tar", ["xf", archive, "--no-same-owner", "-C", extracted]);
      files.push(...(await reconcileDownloadedWorkspace(entry.projectRoot, extracted)));
      return { files };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async stopRun(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.runs.delete(runId);
    this.handlers.delete(runId);
    await entry.sandbox.stop().catch(() => undefined);
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    const auth = credentials();
    if (!auth) {
      return {
        healthy: false,
        detail:
          "Vercel Sandbox auth is not configured (OIDC or access token)",
      };
    }
    try {
      await import("@vercel/sandbox");
      return {
        healthy: true,
        detail:
          auth.mode === "oidc"
            ? "Vercel Sandbox ready via OIDC"
            : "Vercel Sandbox ready via access token",
      };
    } catch (err: any) {
      return { healthy: false, detail: "Vercel Sandbox SDK unavailable: " + (err?.message ?? String(err)) };
    }
  }

  sandboxId(runId: string): string | undefined {
    return this.runs.get(runId)?.sandboxId;
  }

  sandboxName(runId: string): string | undefined {
    return this.runs.get(runId)?.sandboxName;
  }

  isPersistent(runId: string): boolean {
    return this.runs.get(runId)?.persistent === true;
  }

  async dispose(): Promise<void> {
    for (const runId of [...this.runs.keys()]) await this.stopRun(runId);
  }
}
