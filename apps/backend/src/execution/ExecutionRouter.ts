// apps/backend/src/execution/ExecutionRouter.ts
//
// Provider selection + lifecycle management. Chooses the execution location
// per run based on the task, environment, and availability — the desktop
// never branches on location; runtime events remain identical.

import type { ExecutionInfo, ExecutionProvider } from "./ExecutionProvider";
import type { ExecutionLocation } from "./ExecutionProvider";
import { LocalExecutionProvider } from "./LocalExecutionProvider";
import { DockerExecutionProvider } from "./DockerExecutionProvider";
import { OvhWorkerProvider } from "./OvhWorkerProvider";

export type ExecutionPreference = "auto" | ExecutionLocation;

export interface RoutingDecision {
  provider: ExecutionProvider;
  location: ExecutionLocation;
  reason: string;
}

export class ExecutionRouter {
  readonly local: LocalExecutionProvider;
  readonly docker: DockerExecutionProvider;
  readonly ovh: OvhWorkerProvider;

  constructor() {
    this.local = new LocalExecutionProvider();
    this.docker = new DockerExecutionProvider();
    this.ovh = new OvhWorkerProvider();
  }

  /**
   * Selects the provider for a run. Preference order:
   *   explicit request → task-based routing → availability.
   *
   * Task-based defaults:
   *   - isolated coding/sandbox missions → DOCKER_LOCAL (if Docker is up)
   *   - simple chat/read/plan tasks     → LOCAL
   *   - remote-flagged tasks            → OVH_WORKER (if healthy)
   *
   * If the preferred provider is unavailable, falls back truthfully to
   * LOCAL with the reason recorded — never silently pretends.
   */
  async select(opts: {
    preference?: ExecutionPreference;
    /** True when the task needs isolation (code-modifying mission). */
    isIsolated?: boolean;
    /** True when the task was explicitly marked for remote execution. */
    isRemote?: boolean;
  }): Promise<RoutingDecision> {
    const pref = opts.preference ?? "auto";

    if (pref === "LOCAL") {
      return { provider: this.local, location: "LOCAL", reason: "explicitly requested local execution" };
    }
    if (pref === "DOCKER_LOCAL") {
      const dockerHealth = await this.docker.health();
      if (dockerHealth.healthy) {
        return { provider: this.docker, location: "DOCKER_LOCAL", reason: "explicitly requested Docker sandbox" };
      }
      throw new Error(`Local Sandbox unavailable (${dockerHealth.detail ?? "Docker is not running"}). Explicit Sandbox was requested — there is no silent Local fallback.`);
    }
    if (pref === "OVH_WORKER") {
      const ovhHealth = await this.ovh.health();
      if (ovhHealth.healthy) {
        return { provider: this.ovh, location: "OVH_WORKER", reason: "explicitly requested OVH worker" };
      }
      throw new Error(`ORVYN Cloud worker unavailable (${ovhHealth.detail ?? "not configured"}). Explicit Cloud was requested — there is no silent Local fallback.`);
    }

    // auto routing
    if (opts.isRemote) {
      const ovhHealth = await this.ovh.health();
      if (ovhHealth.healthy) {
        return { provider: this.ovh, location: "OVH_WORKER", reason: "task marked for remote execution" };
      }
      const dockerHealth = await this.docker.health();
      if (opts.isIsolated && dockerHealth.healthy) {
        return { provider: this.docker, location: "DOCKER_LOCAL", reason: "remote preferred but ORVYN Cloud unavailable — Docker sandbox for isolation" };
      }
      return { provider: this.local, location: "LOCAL", reason: `remote preferred but ORVYN Cloud unavailable (${ovhHealth.detail}) and isolation${opts.isIsolated ? "" : " not"} needed` };
    }
    if (opts.isIsolated) {
      const dockerHealth = await this.docker.health();
      if (dockerHealth.healthy) {
        return { provider: this.docker, location: "DOCKER_LOCAL", reason: "code-modifying task — Docker sandbox for isolation" };
      }
      return { provider: this.local, location: "LOCAL", reason: `code-modifying task but Docker unavailable (${dockerHealth.detail}) — local execution with approvals` };
    }
    return { provider: this.local, location: "LOCAL", reason: "simple task — local execution" };
  }

  /** Build the execution metadata the run record carries. */
  static executionInfo(decision: RoutingDecision, runId: string): ExecutionInfo {
    const now = Date.now();
    const info: ExecutionInfo = {
      executionLocation: decision.location,
      startedAt: now,
      lastHeartbeat: now,
    };
    if (decision.location === "DOCKER_LOCAL") {
      info.containerId = decision.provider instanceof DockerExecutionProvider
        ? (decision.provider as unknown as { runs: Map<string, { sandbox: { containerId: string } }> }).runs?.get(runId)?.sandbox.containerId
        : undefined;
    }
    if (decision.location === "OVH_WORKER") {
      info.workerId = process.env.ORVYN_OVH_WORKER_URL || "unknown";
    }
    return info;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.local.dispose?.(), this.docker.dispose(), this.ovh.dispose()]);
  }
}
