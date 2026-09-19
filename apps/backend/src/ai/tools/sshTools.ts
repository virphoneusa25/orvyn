// apps/backend/src/ai/tools/sshTools.ts
//
// Remote server administration over SSH, scoped by a host allowlist.
//
// Containment rule: the model may name a host ALIAS and a command — never an
// arbitrary host, user, or key. Aliases resolve server-side from
// `.orvyn/ssh.json` in the project, which the user wrote. Without this the
// tool would be an open relay to any machine the backend can reach.
//
// Key-based auth only. Password auth needs sshpass/pty plumbing that does not
// exist on Windows hosts, and putting passwords in a JSON file next to the
// repo is worse than the problem it solves.

import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { AITool, ToolResult } from "../ToolTypes";

export interface SshHostConfig {
  alias: string;
  host: string;
  user: string;
  port?: number;
  /** Path to a private key; ~ expanded. Omitted = ssh's default key discovery. */
  keyPath?: string;
}

export interface SshToolConfig {
  hosts: SshHostConfig[];
}

export function sshConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".orvyn", "ssh.json");
}

export async function loadSshHosts(projectRoot: string): Promise<SshHostConfig[]> {
  const raw = await fs.readFile(sshConfigPath(projectRoot), "utf-8");
  const parsed = JSON.parse(raw) as Partial<SshToolConfig>;
  if (!Array.isArray(parsed.hosts)) throw new Error(".orvyn/ssh.json must contain a \"hosts\" array");
  return parsed.hosts.filter((h) => h && h.alias && h.host && h.user);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function makeSshExecTool(projectRoot: string): AITool {
  return {
    name: "ssh_exec",
    description:
      "Run a shell command on a remote server over SSH. Hosts must be pre-configured by the user in .orvyn/ssh.json — pass the alias, not a hostname. Key-based auth only. Output is captured and returned.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Alias of the server, as configured in .orvyn/ssh.json" },
        command: { type: "string", description: "Shell command to run on the server" },
      },
      required: ["host", "command"],
    },
    // Remote execution is exactly as dangerous as the terminal tool — every
    // call requires approval, regardless of mode or "Allow for Mission".
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      const alias = String(args.host ?? "").trim();
      const command = String(args.command ?? "").trim();
      if (!alias || !command) {
        return { ok: false, error: "Both \"host\" (an alias from .orvyn/ssh.json) and \"command\" are required." };
      }

      let hosts: SshHostConfig[];
      try {
        hosts = await loadSshHosts(projectRoot);
      } catch (err: any) {
        return {
          ok: false,
          error: `No usable SSH configuration: ${err.message}. Create .orvyn/ssh.json with {"hosts":[{"alias":"myserver","host":"1.2.3.4","user":"root","keyPath":"~/.ssh/id_ed25519"}]}.`,
        };
      }

      const target = hosts.find((h) => h.alias === alias);
      if (!target) {
        const known = hosts.map((h) => h.alias).join(", ") || "(none configured)";
        return { ok: false, error: `Unknown host alias "${alias}". Configured hosts: ${known}.` };
      }

      const sshArgs = [
        "-o", "BatchMode=yes", // never prompt interactively; a hang here blocks the run
        "-o", "ConnectTimeout=15",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", String(target.port ?? 22),
      ];
      if (target.keyPath) sshArgs.push("-i", expandHome(target.keyPath));
      sshArgs.push(`${target.user}@${target.host}`, "--", command);

      return await new Promise<ToolResult>((resolve) => {
        execFile(
          "ssh",
          sshArgs,
          { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (error && !stdout && !stderr) {
              const hint = (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "ssh is not installed on the backend host."
                : "";
              resolve({ ok: false, error: `SSH to "${alias}" failed: ${error.message}${hint ? ` (${hint})` : ""}` });
              return;
            }
            // A nonzero exit code is still a successful command execution —
            // the agent needs the output to diagnose, not an error wrapper.
            const output = [stdout, stderr].filter(Boolean).join("\n").trim();
            resolve({ ok: true, output: output || "(no output)" });
          }
        );
      });
    },
  };
}
