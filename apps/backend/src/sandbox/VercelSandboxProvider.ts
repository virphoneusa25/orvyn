// apps/backend/src/sandbox/VercelSandboxProvider.ts
//
// Vercel Sandbox execution provider for ORVYN cloud missions.
// Keeps ORION/MultiAgentRuntime and the desktop UI provider-neutral.

import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type {
  ExecResult,
  SandboxMergeResult,
  SandboxProvider,
  SandboxSession,
} from "./SandboxProvider";

const WORKSPACE = "/vercel/sandbox/workspace";
const UPLOAD_ARCHIVE = "/vercel/sandbox/orvyn-project.tar";
const COMMAND_TIMEOUT_S =
  Number(process.env.ORVYN_SANDBOX_COMMAND_TIMEOUT_S) || 180;
const MISSION_TIMEOUT_MIN =
  Number(process.env.ORVYN_SANDBOX_TIMEOUT_MIN) || 30;
const MAX_SYNC_ARCHIVE_MB =
  Number(process.env.ORVYN_VERCEL_SYNC_MAX_MB) || 64;

const SYNC_EXCLUDE = [
  "node_modules",
  ".git",
  ".orvyn",
  "dist",
  "release",
  ".cache",
];

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function credentials(): {
  token: string;
  teamId: string;
  projectId: string;
} | null {
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
    ? { token, teamId, projectId }
    : null;
}

function runLocal(
  file: string,
  args: string[],
  timeoutMs = 120_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              file +
                " failed: " +
                String(stderr || error.message).slice(0, 600)
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}

async function makeProjectArchive(
  projectRoot: string
): Promise<{ dir: string; content: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-vercel-in-"));
  const archive = path.join(dir, "project.tar");
  const excludes = SYNC_EXCLUDE.flatMap((entry) => [
    "--exclude",
    entry,
  ]);

  try {
    await runLocal("tar", [
      "cf",
      archive,
      ...excludes,
      "-C",
      projectRoot,
      ".",
    ]);
    const data = await fs.readFile(archive);
    const maxBytes = MAX_SYNC_ARCHIVE_MB * 1024 * 1024;
    if (data.byteLength > maxBytes) {
      throw new Error(
        "Project archive is " +
          Math.ceil(data.byteLength / 1024 / 1024) +
          "MB; ORVYN_VERCEL_SYNC_MAX_MB is " +
          MAX_SYNC_ARCHIVE_MB +
          "MB. Use Git-backed cloud workspace sync for larger projects."
      );
    }
    return { dir, content: data };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function extractArchive(
  archive: string,
  destination: string
): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await runLocal("tar", [
    "xf",
    archive,
    "--no-same-owner",
    "-C",
    destination,
  ]);
}

class VercelSandboxSession implements SandboxSession {
  readonly provider = "vercel";
  readonly workspacePath = WORKSPACE;
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly sandbox: any
  ) {}

  async exec(
    command: string,
    timeoutS = COMMAND_TIMEOUT_S
  ): Promise<ExecResult> {
    if (this.stopped) {
      return {
        ok: false,
        output: "Sandbox has already been stopped.",
        exitCode: -1,
        timedOut: false,
      };
    }

    const wrapped =
      "timeout --signal=KILL " +
      Math.max(1, Math.floor(timeoutS)) +
      " sh -lc " +
      shellQuote(command);

    try {
      const result = await this.sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", wrapped],
        cwd: this.workspacePath,
      });

      let stdout = "";
      let stderr = "";
      try {
        if (typeof result.stdout === "function") {
          stdout = await result.stdout();
        }
      } catch {}
      try {
        if (typeof result.stderr === "function") {
          stderr = await result.stderr();
        }
      } catch {}

      const exitCode = Number(result.exitCode ?? 1);
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();

      return {
        ok: exitCode === 0,
        output: output || "(no output)",
        exitCode,
        timedOut: exitCode === 124 || exitCode === 137,
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      return {
        ok: false,
        output: message,
        exitCode: -1,
        timedOut: /timeout|timed out/i.test(message),
      };
    }
  }

  async mergeBack(projectRoot: string): Promise<SandboxMergeResult> {
    if (this.stopped) return { mergedFiles: 0 };

    const excludeArgs = SYNC_EXCLUDE.map(
      (entry) => "--exclude=" + shellQuote(entry)
    ).join(" ");

    const pack = await this.exec(
      "tar cf /tmp/orvyn-out.tar " +
        excludeArgs +
        " -C " +
        shellQuote(this.workspacePath) +
        " . && stat -c %s /tmp/orvyn-out.tar",
      120
    );

    if (!pack.ok) {
      throw new Error(
        "Could not package Vercel workspace: " + pack.output
      );
    }

    const tokens = pack.output.trim().split(/\s+/);
    const bytes = Number(tokens[tokens.length - 1]);
    const maxBytes = MAX_SYNC_ARCHIVE_MB * 1024 * 1024;
    if (!Number.isFinite(bytes) || bytes > maxBytes) {
      throw new Error(
        "Vercel workspace archive exceeds ORVYN_VERCEL_SYNC_MAX_MB=" +
          MAX_SYNC_ARCHIVE_MB
      );
    }

    const encoded = await this.exec(
      "base64 -w0 /tmp/orvyn-out.tar",
      120
    );
    if (!encoded.ok) {
      throw new Error(
        "Could not download Vercel workspace: " + encoded.output
      );
    }

    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "orvyn-vercel-out-")
    );
    const archive = path.join(dir, "project.tar");
    const extracted = path.join(dir, "project");

    try {
      await fs.writeFile(
        archive,
        Buffer.from(encoded.output.trim(), "base64")
      );
      await extractArchive(archive, extracted);

      const excluded = new Set(SYNC_EXCLUDE);
      let merged = 0;

      const walk = async (src: string, dest: string): Promise<void> => {
        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
          if (excluded.has(entry.name)) continue;
          const from = path.join(src, entry.name);
          const to = path.join(dest, entry.name);

          if (entry.isDirectory()) {
            await fs.mkdir(to, { recursive: true });
            await walk(from, to);
          } else if (entry.isFile()) {
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(from, to);
            merged++;
          }
        }
      };

      await walk(extracted, projectRoot);
      return { mergedFiles: merged };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.sandbox.stop();
  }
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";

  async available(): Promise<boolean> {
    if (!credentials()) return false;
    try {
      await import("@vercel/sandbox");
      return true;
    } catch {
      return false;
    }
  }

  async start(
    missionId: string,
    projectRoot: string
  ): Promise<SandboxSession> {
    const auth = credentials();
    if (!auth) {
      throw new Error(
        "Vercel Sandbox is not configured. Set SANDBOX_VERCEL_TOKEN, " +
          "SANDBOX_VERCEL_TEAM_ID, and SANDBOX_VERCEL_PROJECT_ID."
      );
    }

    const mod = await import("@vercel/sandbox");
    const Sandbox: any = mod.Sandbox;

    const ports = String(
      process.env.ORVYN_VERCEL_SANDBOX_PORTS || "3000,5173"
    )
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    const sandbox: any = await Sandbox.create({
      token: auth.token,
      teamId: auth.teamId,
      projectId: auth.projectId,
      timeout: MISSION_TIMEOUT_MIN * 60_000,
      ports,
      env: {
        ORVYN_MISSION_ID: missionId,
        ORVYN_EXECUTION_PROVIDER: "vercel",
      },
    } as any);

    const nativeId =
      sandbox.sandboxId ?? sandbox.id ?? ("vercel-" + missionId);
    const session = new VercelSandboxSession(
      String(nativeId),
      sandbox
    );

    const archive = await makeProjectArchive(projectRoot);
    try {
      await sandbox.writeFiles([
        {
          path: UPLOAD_ARCHIVE,
          content: archive.content,
        },
      ]);

      const setup = await session.exec(
        "mkdir -p " +
          shellQuote(WORKSPACE) +
          " && tar xf " +
          shellQuote(UPLOAD_ARCHIVE) +
          " --no-same-owner -C " +
          shellQuote(WORKSPACE) +
          " && rm -f " +
          shellQuote(UPLOAD_ARCHIVE),
        120
      );

      if (!setup.ok) {
        throw new Error(
          "Could not initialize Vercel workspace: " +
            setup.output.slice(0, 1000)
        );
      }
    } catch (err) {
      await session.stop().catch(() => undefined);
      throw err;
    } finally {
      await fs.rm(archive.dir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }

    return session;
  }
}
