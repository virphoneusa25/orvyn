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
import { VercelExecutionProvider } from "./VercelExecutionProvider";

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
  readonly vercel: VercelExecutionProvider;

  constructor() {
    this.local = new LocalExecutionProvider();
    this.docker = new DockerExecutionProvider();
    this.ovh = new OvhWorkerProvider();
    this.vercel = new VercelExecutionProvider();
  }

  private cloudPreference(): "vercel" | "ovh" {
    return process.env.ORVYN_CLOUD_EXECUTION_PROVIDER?.trim().toLowerCase() === "vercel"
      ? "vercel"
      : "ovh";
  }

  private async cloud(): Promise<RoutingDecision> {
    if (this.cloudPreference() === "vercel") {
      const health = await this.vercel.health();
      if (health.healthy) {
        return {
          provider: this.vercel,
          location: "VERCEL_CLOUD",
          reason: "ORVYN Cloud is configured for Vercel Sandbox",
        };
      }
      throw new Error(
        `ORVYN Cloud Vercel Sandbox unavailable (${health.detail ?? "not configured"})`
      );
    }

    const health = await this.ovh.health();
    if (health.healthy) {
      return {
        provider: this.ovh,
        location: "OVH_WORKER",
        reason: "ORVYN Cloud is configured for the legacy OVH worker",
      };
    }
    throw new Error(
      `ORVYN Cloud worker unavailable (${health.detail ?? "not configured"})`
    );
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
    if (pref === "OVH_WORKER" || pref === "VERCEL_CLOUD") {
      if (pref === "VERCEL_CLOUD") {
        const health = await this.vercel.health();
        if (health.healthy) {
          return { provider: this.vercel, location: "VERCEL_CLOUD", reason: "explicitly requested Vercel ORVYN Cloud" };
        }
        throw new Error(`Vercel ORVYN Cloud unavailable (${health.detail ?? "not configured"}). Explicit Cloud was requested — there is no silent Local fallback.`);
      }
      const health = await this.ovh.health();
      if (health.healthy) {
        return { provider: this.ovh, location: "OVH_WORKER", reason: "explicitly requested legacy OVH worker" };
      }
      throw new Error(`Legacy ORVYN Cloud worker unavailable (${health.detail ?? "not configured"}). Explicit Cloud was requested — there is no silent Local fallback.`);
    }

    // auto routing
    if (opts.isRemote) {
      try {
        const cloud = await this.cloud();
        return { ...cloud, reason: "task marked for remote ORVYN Cloud execution; " + cloud.reason };
      } catch (cloudError: any) {
        const dockerHealth = await this.docker.health();
        if (opts.isIsolated && dockerHealth.healthy) {
          return { provider: this.docker, location: "DOCKER_LOCAL", reason: "remote preferred but ORVYN Cloud unavailable — Docker sandbox for isolation" };
        }
        return {
          provider: this.local,
          location: "LOCAL",
          reason: `remote preferred but ORVYN Cloud unavailable (${cloudError?.message ?? cloudError}) and isolation${opts.isIsolated ? "" : " not"} needed`,
        };
      }
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
    if (decision.location === "VERCEL_CLOUD" && decision.provider instanceof VercelExecutionProvider) {
      info.sandboxId = decision.provider.sandboxId(runId);
    }
    return info;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.local.dispose?.(),
      this.docker.dispose(),
      this.ovh.dispose(),
      this.vercel.dispose(),
    ]);
  }
}
