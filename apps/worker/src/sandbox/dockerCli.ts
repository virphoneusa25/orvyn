// apps/worker/src/sandbox/dockerCli.ts — thin wrapper over the docker CLI.
import { spawn } from "child_process";

export interface CliResult { code: number; stdout: string; stderr: string }

export function docker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, opts.timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }); });
    p.on("error", () => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: "docker not found" }); });
    if (opts.input !== undefined) { p.stdin.end(opts.input); } else p.stdin.end();
  });
}

/** Docker label values: printable, bounded. Identity values are ids, never secrets. */
export function labelValue(v: string | null | undefined): string {
  return String(v ?? "").replace(/[^\w.:@-]/g, "_").slice(0, 128);
}
