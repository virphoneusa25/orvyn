// apps/backend/src/execution/DockerExecutionProvider.ts
//
// Adapts the existing DockerSandbox into the ExecutionProvider interface —
// no duplication, the sandbox is the engine; this class is the adapter that
// maps its start/exec/mergeBack/stop lifecycle onto provider calls.

import { DockerSandbox } from "../sandbox/DockerSandbox";
import type { CommandResult, ExecutionProvider } from "./ExecutionProvider";

interface RunSandbox {
  sandbox: DockerSandbox;
  projectRoot: string;
  cancelled: boolean;
}

export class DockerExecutionProvider implements ExecutionProvider {
  readonly location = "DOCKER_LOCAL" as const;
  private runs = new Map<string, RunSandbox>();
  private outputHandlers = new Map<string, (chunk: string) => void>();

  async startRun(runId: string, projectRoot: string): Promise<void> {
    // Stop any prior sandbox for this run (re-run safety).
    await this.stopRun(runId);
    const sandbox = await DockerSandbox.start(runId, projectRoot);
    this.runs.set(runId, { sandbox, projectRoot, cancelled: false });
  }

  async executeCommand(runId: string, command: string, opts?: { timeoutS?: number; cwd?: string }): Promise<CommandResult> {
    const entry = this.runs.get(runId);
    if (!entry) return { ok: false, output: "No sandbox started for this run.", exitCode: -1 };
    if (entry.cancelled) return { ok: false, output: "Run cancelled.", exitCode: -1 };
    const result = await entry.sandbox.exec(command, opts?.timeoutS ?? 120);
    const handler = this.outputHandlers.get(runId);
    if (handler && result.output) handler(result.output);
    return { ok: result.ok, output: result.output, exitCode: result.ok ? 0 : 1 };
  }

  onOutput(runId: string, cb: (chunk: string) => void): void {
    this.outputHandlers.set(runId, cb);
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.cancelled = true;
    // Kill any in-container process, then the sandbox itself follows at stopRun.
    await entry.sandbox.stop().catch(() => {});
  }

  async uploadWorkspace(runId: string): Promise<void> {
    // The sandbox copies the project at startRun — a re-upload hook for
    // future incremental sync. No-op today (workspace already inside).
    void runId;
  }

  async downloadArtifacts(runId: string): Promise<{ files: string[] }> {
    const entry = this.runs.get(runId);
    if (!entry) return { files: [] };
    const result = await entry.sandbox.mergeBack(entry.projectRoot);
    return { files: [] }; // mergeBack syncs files directly; no artifact list yet
  }

  async stopRun(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.runs.delete(runId);
    this.outputHandlers.delete(runId);
    await entry.sandbox.stop().catch(() => {});
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    const ok = await DockerSandbox.available().catch(() => false);
    return { healthy: ok, detail: ok ? undefined : "Docker daemon not reachable" };
  }

  async dispose(): Promise<void> {
    for (const runId of [...this.runs.keys()]) {
      await this.stopRun(runId);
    }
  }
}
