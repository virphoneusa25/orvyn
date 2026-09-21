// apps/backend/src/execution/OvhWorkerProvider.ts
//
// The OVH_WORKER provider stub. The interface is REAL — health() honestly
// reports unavailable, startRun() rejects with a clear message. No fake
// remote execution. When the OVH worker API exists, this class gets a real
// transport without changing any calling code.

import type { CommandResult, ExecutionProvider } from "./ExecutionProvider";

const NOT_DEPLOYED = "OVH worker not deployed yet — configure the worker service and set ORVYN_OVH_WORKER_URL";

export class OvhWorkerProvider implements ExecutionProvider {
  readonly location = "OVH_WORKER" as const;
  private workerUrl: string | null;

  constructor() {
    this.workerUrl = process.env.ORVYN_OVH_WORKER_URL?.trim() || null;
  }

  private unavailable(): Error {
    return new Error(NOT_DEPLOYED);
  }

  async startRun(): Promise<void> {
    throw this.unavailable();
  }

  async executeCommand(): Promise<CommandResult> {
    return { ok: false, output: NOT_DEPLOYED, exitCode: -1 };
  }

  async cancel(): Promise<void> {
    // No remote run to cancel — truthful no-op.
  }

  async uploadWorkspace(): Promise<void> {
    throw this.unavailable();
  }

  async downloadArtifacts(): Promise<{ files: string[] }> {
    return { files: [] };
  }

  async stopRun(): Promise<void> {}

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    if (!this.workerUrl) {
      return { healthy: false, detail: NOT_DEPLOYED };
    }
    // When configured, probe the worker's health endpoint.
    try {
      const res = await fetch(`${this.workerUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return { healthy: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err: any) {
      return { healthy: false, detail: `Worker unreachable: ${err.message}` };
    }
  }

  async dispose(): Promise<void> {}
}
