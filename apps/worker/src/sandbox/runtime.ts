// apps/worker/src/sandbox/runtime.ts
//
// Picks and drives the execution sandbox for one mission on this worker.
// The control plane sends the plan (provider, fallback, policy template,
// plan-tier resources, retention); this class obeys it, falls back only
// when the plan allows, reattaches to live sandboxes after a restart, and
// keeps the numbers admin System Health shows.

import { DockerExecutionProvider } from "./docker";
import { OpenShellExecutionProvider, classifyExecOutput, openShellConfigFromEnv, type OpenShellConfig } from "./openshell";
import {
  SandboxError,
  isPolicyTemplate,
  type CreateSandboxSpec,
  type AttachOptions,
  type AttachSession,
  type CredentialGrant,
  type ExecOptions,
  type ExecResult,
  type ExecutionProviderId,
  type ExecutionSandboxProvider,
  type PolicyTemplateId,
  type ProviderHealth,
  type RetentionPolicy,
  type SandboxHandle,
  type SandboxIdentity,
  type SandboxResources,
} from "./types";

export interface SandboxPlan {
  sandboxId: string;
  provider: ExecutionProviderId;
  fallback: "docker" | "none";
  policyTemplate: PolicyTemplateId;
  resources: SandboxResources;
  retention: RetentionPolicy;
  credentials: CredentialGrant[];
}

/** The plan a pre-OpenShell control plane implies: the old fixed container. */
export function legacyPlan(runId: string, lifetimeS: number): SandboxPlan {
  return {
    sandboxId: `sbx_${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
    provider: "docker", fallback: "none", policyTemplate: "code-basic",
    resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, commandTimeoutS: 300, maxLifetimeS: lifetimeS },
    retention: "ephemeral", credentials: [],
  };
}

/** Validates a plan from the wire. Anything malformed becomes the safe default, never wider. */
export function normalizePlan(raw: any, runId: string, lifetimeS: number): SandboxPlan {
  const base = legacyPlan(runId, lifetimeS);
  if (!raw || typeof raw !== "object") return base;
  const id = typeof raw.sandboxId === "string" && /^sbx_[a-zA-Z0-9]{8,40}$/.test(raw.sandboxId) ? raw.sandboxId : base.sandboxId;
  const r = raw.resources ?? {};
  const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    sandboxId: id,
    provider: raw.provider === "openshell" ? "openshell" : "docker",
    fallback: raw.fallback === "docker" ? "docker" : "none",
    policyTemplate: isPolicyTemplate(raw.policyTemplate) ? raw.policyTemplate : "code-basic",
    resources: {
      cpus: clamp(r.cpus, 0.25, 16, base.resources.cpus),
      memoryMb: clamp(r.memoryMb, 256, 65_536, base.resources.memoryMb),
      pidsLimit: clamp(r.pidsLimit, 64, 8192, base.resources.pidsLimit),
      commandTimeoutS: clamp(r.commandTimeoutS, 10, 3600, base.resources.commandTimeoutS),
      maxLifetimeS: clamp(r.maxLifetimeS, 60, 86_400, base.resources.maxLifetimeS),
    },
    retention: raw.retention === "retained" ? "retained" : "ephemeral",
    credentials: Array.isArray(raw.credentials)
      ? raw.credentials.filter((c: any) => c && typeof c.integrationId === "string" && typeof c.type === "string" && typeof c.organizationId === "string")
      : [],
  };
}

export interface RuntimeEvents {
  /** Customer-visible run events: neutral wording, no provider names. */
  emit(runId: string, type: string, data: Record<string, unknown>): Promise<void>;
  /** Control-plane registry report (admin-only detail). */
  report(runId: string, body: Record<string, unknown>): Promise<void>;
}

interface Metrics {
  provisionMs: number[];
  reconnects: number;
  failures: number;
  policyDenials: number;
  fallbacks: number;
  execs: number;
}

export class SandboxRuntime {
  readonly providers: Partial<Record<ExecutionProviderId, ExecutionSandboxProvider>> = {};
  private handles = new Map<string, SandboxHandle>();
  private metrics: Record<ExecutionProviderId, Metrics> = {
    docker: { provisionMs: [], reconnects: 0, failures: 0, policyDenials: 0, fallbacks: 0, execs: 0 },
    openshell: { provisionMs: [], reconnects: 0, failures: 0, policyDenials: 0, fallbacks: 0, execs: 0 },
  };
  private health: Partial<Record<ExecutionProviderId, ProviderHealth>> = {};

  constructor(private readonly events: RuntimeEvents, opts: { docker?: ExecutionSandboxProvider; openshell?: ExecutionSandboxProvider | null; openshellConfig?: OpenShellConfig | null } = {}) {
    this.providers.docker = opts.docker ?? new DockerExecutionProvider();
    if (opts.openshell !== undefined) {
      if (opts.openshell) this.providers.openshell = opts.openshell;
    } else if (process.env.OPENSHELL_ENABLED === "true") {
      const cfg = opts.openshellConfig ?? openShellConfigFromEnv();
      if (cfg) this.providers.openshell = new OpenShellExecutionProvider(cfg);
    }
  }

  handleFor(runId: string): SandboxHandle | undefined { return this.handles.get(runId); }
  activeHandles(): SandboxHandle[] { return [...this.handles.values()]; }

  private async createOn(provider: ExecutionSandboxProvider, spec: CreateSandboxSpec, runId: string): Promise<SandboxHandle> {
    await this.events.emit(runId, "sandbox.created", { sandboxId: spec.sandboxId, policy: spec.policyTemplate, retention: spec.retention });
    // Retained sandboxes and restarted workers: reattach before creating.
    const existing = await provider.getSandbox(spec.sandboxId, spec.identity).catch(() => null);
    if (existing && (existing.state === "ready" || existing.state === "running")) {
      this.metrics[provider.id].reconnects++;
      await this.events.emit(runId, "sandbox.reconnected", { sandboxId: spec.sandboxId });
      await this.events.report(runId, { sandboxId: spec.sandboxId, state: "ready", providerSandboxId: existing.providerSandboxId, reconnect: true });
      return existing;
    }
    if (existing) await provider.destroy(existing).catch(() => {});
    const handle = await provider.createSandbox(spec);
    if (handle.provisionMs !== undefined) {
      const arr = this.metrics[provider.id].provisionMs;
      arr.push(handle.provisionMs);
      if (arr.length > 200) arr.shift();
    }
    return handle;
  }

  /** Brings up (or reattaches) the sandbox for a run. */
  async acquire(runId: string, plan: SandboxPlan, identity: SandboxIdentity, workspaceHostPath: string, extra: { image?: string } = {}): Promise<SandboxHandle> {
    const spec: CreateSandboxSpec = {
      sandboxId: plan.sandboxId, identity, workspaceHostPath, resources: plan.resources,
      policyTemplate: plan.policyTemplate, retention: plan.retention, credentials: plan.credentials,
      ...(extra.image ? { image: extra.image } : {}),
    };
    let providerId: ExecutionProviderId = plan.provider;
    let fallbackReason: string | null = null;
    let provider = this.providers[providerId];
    if (!provider) {
      if (plan.fallback !== "docker") throw new SandboxError("sandbox_unavailable", "The isolated runtime is not enabled on this worker.", false);
      fallbackReason = "runtime not enabled on this worker";
      providerId = "docker";
      provider = this.providers.docker!;
    }
    let handle: SandboxHandle;
    try {
      handle = await this.createOn(provider, spec, runId);
    } catch (e: any) {
      const err = e instanceof SandboxError ? e : new SandboxError("sandbox_unavailable", String(e?.message ?? e));
      this.metrics[providerId].failures++;
      if (providerId === "openshell" && plan.fallback === "docker" && err.kind === "sandbox_unavailable") {
        fallbackReason = err.message.slice(0, 200);
        providerId = "docker";
        await this.events.report(runId, { sandboxId: plan.sandboxId, state: "recovering", fallbackTo: "docker", fallbackReason, lastError: err.message });
        handle = await this.createOn(this.providers.docker!, { ...spec, retention: "ephemeral" }, runId);
      } else {
        await this.events.report(runId, { sandboxId: plan.sandboxId, state: "failed", lastError: err.message });
        await this.events.emit(runId, "sandbox.failed", { sandboxId: plan.sandboxId, reason: "The mission workspace could not be started." });
        throw err;
      }
    }
    if (fallbackReason) {
      this.metrics[providerId].fallbacks++;
      await this.events.report(runId, { sandboxId: plan.sandboxId, fallbackTo: providerId, fallbackReason });
    }
    this.handles.set(runId, handle);
    await this.events.report(runId, {
      sandboxId: handle.sandboxId, state: "ready", providerSandboxId: handle.providerSandboxId,
      provisionMs: handle.provisionMs, policyTemplate: handle.policyTemplate, policyVersion: handle.policyVersion,
    });
    return handle;
  }

  /** Runs a command in the run's sandbox, classifying policy denials. */
  async exec(runId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult & { failureKind?: string }> {
    const handle = this.handles.get(runId);
    if (!handle) throw new SandboxError("sandbox_unavailable", "No sandbox for this run.");
    const provider = this.providers[handle.provider]!;
    this.metrics[handle.provider].execs++;
    let result: ExecResult;
    try {
      result = await provider.exec(handle, command, opts);
    } catch (e: any) {
      if (e instanceof SandboxError && e.kind === "sandbox_unavailable") {
        // One reconnect attempt: the sandbox may still exist behind a flaky gateway call.
        const again = await provider.getSandbox(handle.sandboxId, handle.identity).catch(() => null);
        if (again && (again.state === "ready" || again.state === "running")) {
          this.metrics[handle.provider].reconnects++;
          await this.events.report(runId, { sandboxId: handle.sandboxId, reconnect: true });
          result = await provider.exec(again, command, opts);
        } else throw e;
      } else throw e;
    }
    const denial = handle.provider === "openshell" ? classifyExecOutput(result) : null;
    if (denial) {
      this.metrics[handle.provider].policyDenials++;
      await this.events.emit(runId, "sandbox.policy.denied", { sandboxId: handle.sandboxId, kind: denial });
      await this.events.report(runId, { sandboxId: handle.sandboxId, policyDenied: denial });
    }
    await this.events.report(runId, { sandboxId: handle.sandboxId, execMs: result.completedAt - result.startedAt });
    return denial ? { ...result, failureKind: denial } : result;
  }

  /** Opens a live bidirectional process inside the run's existing sandbox. */
  async attach(runId: string, opts: AttachOptions = {}): Promise<AttachSession> {
    const handle = this.handles.get(runId);
    if (!handle) throw new SandboxError("sandbox_unavailable", "No sandbox for this run.");
    return this.providers[handle.provider]!.attach(handle, opts);
  }

  async applyPolicy(runId: string, template: PolicyTemplateId, params: Record<string, string[]>, credentials: CredentialGrant[] = []): Promise<void> {
    const handle = this.handles.get(runId);
    if (!handle) throw new SandboxError("sandbox_unavailable", "No sandbox for this run.");
    if (!isPolicyTemplate(template)) throw new SandboxError("tool_bad_args", "Unknown policy template.", false);
    // Grants are only ever for the sandbox's own organization.
    const grants = credentials.filter((g) => g && g.organizationId === handle.identity.organizationId);
    const provider = this.providers[handle.provider]!;
    if (!provider.updateNetworkPolicy) throw new SandboxError("network_policy_denied", "This workspace cannot open network access.", false);
    await provider.updateNetworkPolicy(handle, template, params, grants);
  }

  /** Ends the run's use of its sandbox. Retained sandboxes stay up for the next run. */
  async release(runId: string, reason: string, opts: { force?: boolean } = {}): Promise<void> {
    const handle = this.handles.get(runId);
    this.handles.delete(runId);
    if (!handle) return;
    const provider = this.providers[handle.provider]!;
    if (handle.retention === "retained" && !opts.force) {
      await this.events.report(runId, { sandboxId: handle.sandboxId, state: "ready", released: true });
      return;
    }
    try {
      await provider.destroy(handle);
      await this.events.emit(runId, "sandbox.destroyed", { sandboxId: handle.sandboxId, reason });
      await this.events.report(runId, { sandboxId: handle.sandboxId, state: opts.force ? "stopped" : "completed", destroyedAt: Date.now() });
    } catch (e: any) {
      await this.events.report(runId, { sandboxId: handle.sandboxId, state: "degraded", lastError: `destroy failed: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }

  async refreshHealth(): Promise<void> {
    for (const [id, p] of Object.entries(this.providers) as Array<[ExecutionProviderId, ExecutionSandboxProvider]>) {
      this.health[id] = await p.getHealth().catch((e) => ({ provider: id, healthy: false, detail: String(e?.message ?? e).slice(0, 120), checkedAt: Date.now() }));
    }
  }

  /** Heartbeat payload for admin System Health. No secrets, no paths. */
  stats(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const id of ["docker", "openshell"] as ExecutionProviderId[]) {
      const m = this.metrics[id];
      const sorted = [...m.provisionMs].sort((a, b) => a - b);
      out[id] = {
        enabled: Boolean(this.providers[id]),
        health: this.health[id] ?? null,
        active: this.activeHandles().filter((h) => h.provider === id).length,
        failures: m.failures, reconnects: m.reconnects, policyDenials: m.policyDenials, fallbacks: m.fallbacks, execs: m.execs,
        provisionMsAvg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
        provisionMsP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
      };
    }
    return out;
  }

  /**
   * Reconciliation: removes ORVYN sandboxes nobody is using — orphans left by
   * a crash, ephemeral sandboxes of finished runs, retained sandboxes past
   * their TTL. `live` is the set the control plane still considers in use.
   */
  async reconcile(live: Set<string>, now = Date.now()): Promise<{ removed: string[]; kept: number }> {
    const removed: string[] = [];
    let kept = 0;
    const mine = new Set(this.activeHandles().map((h) => h.sandboxId));
    for (const [id, p] of Object.entries(this.providers) as Array<[ExecutionProviderId, ExecutionSandboxProvider]>) {
      let rows: Awaited<ReturnType<ExecutionSandboxProvider["list"]>> = [];
      try { rows = await p.list(); } catch { continue; }
      for (const row of rows) {
        const expires = Number(row.labels["orvyn.expires_at"] ?? row.labels["orvyn.ai/expires-at"]) || 0;
        const retained = (row.labels["orvyn.retention"] ?? row.labels["orvyn.ai/retention"]) === "retained";
        const inUse = mine.has(row.sandboxId);
        const expired = expires > 0 && expires < now;
        const orphan = !inUse && !live.has(row.sandboxId) && (!retained || expired);
        // Never touch a sandbox younger than 2 minutes: it may be mid-create by another worker.
        if ((orphan || (expired && !inUse)) && now - row.createdAt > 120_000) {
          const identity: SandboxIdentity = { organizationId: "", tenantId: "", userId: "", projectId: null, workspaceId: "" };
          const scope = row.labels["openshell.workspace"];
          const handle: SandboxHandle = {
            sandboxId: row.sandboxId, provider: id, providerSandboxId: row.providerSandboxId, name: row.name, identity,
            state: row.state, createdAt: row.createdAt, policyTemplate: "code-basic", policyVersion: 1, retention: "ephemeral",
            ...(scope ? { scope } : {}),
          };
          try { await p.destroy(handle); removed.push(row.sandboxId || row.name); } catch { /* next pass */ }
        } else kept++;
      }
    }
    return { removed, kept };
  }
}
