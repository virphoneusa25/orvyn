// apps/backend/src/execution/LocalExecutionProvider.ts
//
// The LOCAL executor: commands run on this machine's shell in the project
// directory. This is the default when Docker is unavailable or the user
// hasn't enabled sandbox mode. It implements the same ExecutionProvider
// interface the DockerSandbox adapts into, so the runtime code never
// branches on execution location.

import { exec } from "child_process";
import * as path from "path";
import type { CommandResult, ExecutionProvider } from "./ExecutionProvider";

export class LocalExecutionProvider implements ExecutionProvider {
  readonly location = "LOCAL" as const;
  private active = new Map<string, { aborted: boolean }>();

  async startRun(runId: string, projectRoot: string): Promise<void> {
    this.active.set(runId, { aborted: false });
    void projectRoot; // commands use cwd from executeCommand
  }

  async executeCommand(runId: string, command: string, opts?: { timeoutS?: number; cwd?: string }): Promise<CommandResult> {
    const state = this.active.get(runId);
    if (state?.aborted) return { ok: false, output: "Run cancelled.", exitCode: -1 };
    return new Promise<CommandResult>((resolve) => {
      exec(command, {
        timeout: (opts?.timeoutS ?? 120) * 1000,
        maxBuffer: 2 * 1024 * 1024,
        cwd: opts?.cwd,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (this.active.get(runId)?.aborted) {
          resolve({ ok: false, output: "Cancelled by user.", exitCode: -1 });
          return;
        }
        if (error) {
          resolve({ ok: false, output: stderr || error.message, exitCode: error.code ?? 1, timedOut: error.killed });
        } else {
          resolve({ ok: true, output: stdout || stderr });
        }
      });
    });
  }

  async cancel(runId: string): Promise<void> {
    const s = this.active.get(runId);
    if (s) s.aborted = true;
  }

  async uploadWorkspace(): Promise<void> {} // already local — no-op

  async downloadArtifacts(): Promise<{ files: string[] }> {
    return { files: [] }; // local: files are already on the host
  }

  async stopRun(runId: string): Promise<void> {
    this.active.delete(runId);
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true };
  }

  async dispose(): Promise<void> {
    this.active.clear();
  }
}
