// apps/backend/src/execution/sandbox/SandboxRegistry.ts
//
// The control plane's record of every execution sandbox: which provider runs
// it, which organization/user/project/workspace/run owns it, and where it is
// in its lifecycle. ORVYN ids are the keys; provider ids are only pointers.
// Identity columns are immutable after insert — an update that tries to move
// a sandbox to another organization is refused, not applied.
//
// Also holds the runtime feature flags (openshell_runtime per org/project),
// network-policy expansion requests, and the sandbox audit log.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";

export type SandboxProvider = "docker" | "openshell";
export type SandboxState = "provisioning" | "ready" | "running" | "degraded" | "recovering" | "completed" | "failed" | "stopping" | "stopped";
export const SANDBOX_STATES: SandboxState[] = ["provisioning", "ready", "running", "degraded", "recovering", "completed", "failed", "stopping", "stopped"];

export interface SandboxRecord {
  id: string;
  provider: SandboxProvider;
  providerSandboxId: string | null;
  organizationId: string;
  tenantId: string;
  userId: string;
  projectId: string | null;
  workspaceId: string;
  missionId: string | null;
  runId: string | null;
  state: SandboxState;
  policyTemplate: string;
  policyVersion: number;
  retention: "ephemeral" | "retained";
  workerId: string | null;
  fallbackReason: string | null;
  provisionMs: number | null;
  reconnects: number;
  execCount: number;
  execMs: number;
  policyDenials: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  readyAt: number | null;
  destroyedAt: number | null;
  expiresAt: number | null;
}

export interface PolicyRequest {
  id: string;
  sandboxId: string | null;
  runId: string;
  organizationId: string;
  template: string;
  params: Record<string, string[]>;
  reason: string;
  status: "pending" | "approved" | "denied" | "applied" | "failed" | "expired";
  requestedBy: string;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  appliedAt: number | null;
}

const IMMUTABLE: Array<keyof SandboxRecord> = ["provider", "organizationId", "tenantId", "userId", "projectId", "workspaceId", "runId", "createdAt"];

function snake(k: string): string { return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }

export class SandboxRegistry {
  readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_sandboxes (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_sandbox_id TEXT,
        organization_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT,
        workspace_id TEXT NOT NULL,
        mission_id TEXT,
        run_id TEXT,
        state TEXT NOT NULL,
        policy_template TEXT NOT NULL DEFAULT 'code-basic',
        policy_version INTEGER NOT NULL DEFAULT 1,
        retention TEXT NOT NULL DEFAULT 'ephemeral',
        worker_id TEXT,
        fallback_reason TEXT,
        provision_ms INTEGER,
        reconnects INTEGER NOT NULL DEFAULT 0,
        exec_count INTEGER NOT NULL DEFAULT 0,
        exec_ms INTEGER NOT NULL DEFAULT 0,
        policy_denials INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ready_at INTEGER,
        destroyed_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sbx_org ON execution_sandboxes (organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sbx_run ON execution_sandboxes (run_id);
      CREATE INDEX IF NOT EXISTS idx_sbx_state ON execution_sandboxes (state, updated_at);
      CREATE TABLE IF NOT EXISTS sandbox_audit (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT,
        organization_id TEXT,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sbx_audit ON sandbox_audit (organization_id, at);
      CREATE INDEX IF NOT EXISTS idx_sbx_audit_type ON sandbox_audit (type, at);
      CREATE TABLE IF NOT EXISTS runtime_flags (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        flag TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, scope_id, flag)
      );
      CREATE TABLE IF NOT EXISTS sandbox_policy_requests (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT,
        run_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        template TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        applied_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sbx_req ON sandbox_policy_requests (organization_id, status, created_at);
    `);
  }

  private row(r: any): SandboxRecord | null {
    if (!r) return null;
    return {
      id: r.id, provider: r.provider, providerSandboxId: r.provider_sandbox_id, organizationId: r.organization_id,
      tenantId: r.tenant_id, userId: r.user_id, projectId: r.project_id, workspaceId: r.workspace_id,
      missionId: r.mission_id, runId: r.run_id, state: r.state, policyTemplate: r.policy_template,
      policyVersion: r.policy_version, retention: r.retention, workerId: r.worker_id, fallbackReason: r.fallback_reason,
      provisionMs: r.provision_ms, reconnects: r.reconnects, execCount: r.exec_count, execMs: r.exec_ms,
      policyDenials: r.policy_denials, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
      readyAt: r.ready_at, destroyedAt: r.destroyed_at, expiresAt: r.expires_at,
    };
  }

  /** Inserts the planned sandbox (state provisioning) — done by the control plane when it queues the job. */
  plan(rec: Pick<SandboxRecord, "id" | "provider" | "organizationId" | "tenantId" | "userId" | "projectId" | "workspaceId" | "runId" | "policyTemplate" | "retention"> & { missionId?: string | null; fallbackReason?: string | null; expiresAt?: number | null }, now = Date.now()): SandboxRecord {
    const existing = this.get(rec.id);
    if (existing) {
      // Retained sandboxes are reused by later runs of the same project. Identity must match.
      for (const k of ["organizationId", "tenantId", "projectId", "workspaceId", "provider"] as const) {
        if ((existing as any)[k] !== (rec as any)[k]) throw new Error(`sandbox ${rec.id}: ${k} is immutable`);
      }
      this.db.prepare(`UPDATE execution_sandboxes SET run_id = ?, state = 'provisioning', updated_at = ?, destroyed_at = NULL, expires_at = COALESCE(?, expires_at) WHERE id = ?`)
        .run(rec.runId, now, rec.expiresAt ?? null, rec.id);
      return this.get(rec.id)!;
    }
    this.db.prepare(`INSERT INTO execution_sandboxes (id, provider, organization_id, tenant_id, user_id, project_id, workspace_id, mission_id, run_id, state, policy_template, policy_version, retention, fallback_reason, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, 1, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.provider, rec.organizationId, rec.tenantId, rec.userId, rec.projectId, rec.workspaceId, rec.missionId ?? null, rec.runId, rec.policyTemplate, rec.retention, rec.fallbackReason ?? null, now, now, rec.expiresAt ?? null);
    return this.get(rec.id)!;
  }

  get(id: string): SandboxRecord | null {
    return this.row(this.db.prepare(`SELECT * FROM execution_sandboxes WHERE id = ?`).get(id));
  }

  forRun(runId: string): SandboxRecord | null {
    return this.row(this.db.prepare(`SELECT * FROM execution_sandboxes WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1`).get(runId));
  }

  /**
   * Applies a worker report. Only mutable columns change. A report that
   * names a different owner than the record is rejected (returns null).
   */
  report(id: string, patch: Partial<SandboxRecord>, now = Date.now()): SandboxRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    for (const k of IMMUTABLE) {
      if (patch[k] !== undefined && patch[k] !== cur[k]) return null;
    }
    const sets: string[] = [];
    const vals: any[] = [];
    const put = (k: keyof SandboxRecord, v: unknown) => { sets.push(`${snake(k)} = ?`); vals.push(v); };
    if (patch.state && SANDBOX_STATES.includes(patch.state)) {
      put("state", patch.state);
      if (patch.state === "ready" && !cur.readyAt) put("readyAt", now);
    }
    if (patch.provider && patch.provider !== cur.provider) return null;
    if (patch.providerSandboxId !== undefined) put("providerSandboxId", patch.providerSandboxId);
    if (patch.workerId !== undefined) put("workerId", patch.workerId);
    if (patch.policyTemplate) put("policyTemplate", patch.policyTemplate);
    if (patch.policyVersion) put("policyVersion", patch.policyVersion);
    if (patch.provisionMs !== undefined) put("provisionMs", patch.provisionMs);
    if (patch.fallbackReason !== undefined) put("fallbackReason", patch.fallbackReason);
    if (patch.lastError !== undefined) put("lastError", patch.lastError ? String(patch.lastError).slice(0, 500) : null);
    if (patch.expiresAt !== undefined) put("expiresAt", patch.expiresAt);
    if (patch.destroyedAt !== undefined && !cur.destroyedAt) put("destroyedAt", patch.destroyedAt);
    put("updatedAt", now);
    vals.push(id);
    this.db.prepare(`UPDATE execution_sandboxes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  /** Swaps the provider when the worker fell back (openshell → docker). Recorded, never silent. */
  recordFallback(id: string, to: SandboxProvider, reason: string, now = Date.now()): void {
    this.db.prepare(`UPDATE execution_sandboxes SET provider = ?, fallback_reason = ?, updated_at = ? WHERE id = ?`).run(to, reason.slice(0, 300), now, id);
  }

  bump(id: string, field: "reconnects" | "policyDenials", n = 1): void {
    this.db.prepare(`UPDATE execution_sandboxes SET ${snake(field)} = ${snake(field)} + ?, updated_at = ? WHERE id = ?`).run(n, Date.now(), id);
  }

  addExec(id: string, ms: number): void {
    this.db.prepare(`UPDATE execution_sandboxes SET exec_count = exec_count + 1, exec_ms = exec_ms + ?, updated_at = ? WHERE id = ?`).run(Math.max(0, Math.round(ms)), Date.now(), id);
  }

  listForOrganization(organizationId: string, limit = 50): SandboxRecord[] {
    return (this.db.prepare(`SELECT * FROM execution_sandboxes WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`).all(organizationId, limit) as any[]).map((r) => this.row(r)!);
  }

  listForTenant(tenantId: string, limit = 50): SandboxRecord[] {
    return (this.db.prepare(`SELECT * FROM execution_sandboxes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`).all(tenantId, limit) as any[]).map((r) => this.row(r)!);
  }

  active(): SandboxRecord[] {
    return (this.db.prepare(`SELECT * FROM execution_sandboxes WHERE state NOT IN ('completed','failed','stopped') ORDER BY created_at DESC`).all() as any[]).map((r) => this.row(r)!);
  }

  /** Check lifecycle and human approval within the same storage transaction. */
  authorizedSandbox(runId:string,templates:string[]):SandboxRecord|null{
    const rec=this.forRun(runId);
    if(!rec||rec.provider!=="openshell"||["completed","failed","stopped"].includes(rec.state))return null;
    return this.policyRequests({runId,limit:50}).some(r=>(r.status==="approved"||r.status==="applied")&&templates.includes(r.template))?rec:null;
  }

  failures(limit=25):SandboxRecord[]{
    return (this.db.prepare("SELECT * FROM execution_sandboxes WHERE state = 'failed' OR fallback_reason IS NOT NULL ORDER BY updated_at DESC LIMIT ?").all(limit) as any[]).map(r=>this.row(r)!);
  }

  /** Aggregates for admin System Health. */
  stats(sinceMs: number, now = Date.now()): {
    byProvider: Record<string, { active: number; failed: number; created: number; avgProvisionMs: number | null; p95ProvisionMs: number | null; reconnects: number; policyDenials: number; execCount: number; execMs: number; fallbacks: number }>;
  } {
    const out: Record<string, any> = {};
    for (const p of ["docker", "openshell"]) {
      const since = now - sinceMs;
      const q = (sql: string, ...a: any[]) => this.db.prepare(sql).get(p, ...a) as any;
      const active = q(`SELECT COUNT(*) n FROM execution_sandboxes WHERE provider = ? AND state NOT IN ('completed','failed','stopped')`).n;
      const failed = q(`SELECT COUNT(*) n FROM execution_sandboxes WHERE provider = ? AND state = 'failed' AND updated_at >= ?`, since).n;
      const agg = q(`SELECT COUNT(*) created, AVG(provision_ms) avg, SUM(reconnects) rc, SUM(policy_denials) pd, SUM(exec_count) ec, SUM(exec_ms) em, SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END) fb FROM execution_sandboxes WHERE provider = ? AND created_at >= ?`, since);
      const times = (this.db.prepare(`SELECT provision_ms v FROM execution_sandboxes WHERE provider = ? AND created_at >= ? AND provision_ms IS NOT NULL ORDER BY provision_ms`).all(p, since) as any[]).map((r) => Number(r.v));
      out[p] = {
        active, failed, created: agg.created ?? 0,
        avgProvisionMs: agg.avg == null ? null : Math.round(agg.avg),
        p95ProvisionMs: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]! : null,
        reconnects: agg.rc ?? 0, policyDenials: agg.pd ?? 0, execCount: agg.ec ?? 0, execMs: agg.em ?? 0, fallbacks: agg.fb ?? 0,
      };
    }
    return { byProvider: out };
  }

  /** Runs whose sandbox is still marked live but whose run has ended — stale rows for reconciliation. */
  staleCandidates(olderThanMs: number, now = Date.now()): SandboxRecord[] {
    return (this.db.prepare(`SELECT * FROM execution_sandboxes WHERE state NOT IN ('completed','failed','stopped') AND updated_at < ?`).all(now - olderThanMs) as any[]).map((r) => this.row(r)!);
  }

  // ── flags ────────────────────────────────────────────────────────────
  setFlag(scope: "org" | "project", scopeId: string, flag: string, enabled: boolean, actor: string, now = Date.now()): void {
    this.db.prepare(`INSERT INTO runtime_flags (scope, scope_id, flag, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id, flag) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(scope, scopeId, flag, enabled ? 1 : 0, actor, now);
  }

  flag(scope: "org" | "project", scopeId: string, flag: string): boolean | null {
    const r = this.db.prepare(`SELECT enabled FROM runtime_flags WHERE scope = ? AND scope_id = ? AND flag = ?`).get(scope, scopeId, flag) as any;
    return r ? Boolean(r.enabled) : null;
  }

  flags(flag: string): Array<{ scope: string; scopeId: string; enabled: boolean; updatedBy: string; updatedAt: number }> {
    return (this.db.prepare(`SELECT * FROM runtime_flags WHERE flag = ? ORDER BY updated_at DESC`).all(flag) as any[])
      .map((r) => ({ scope: r.scope, scopeId: r.scope_id, enabled: Boolean(r.enabled), updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  // ── audit ────────────────────────────────────────────────────────────
  audit(type: string, actor: string, opts: { sandboxId?: string | null; organizationId?: string | null; detail?: Record<string, unknown> } = {}, now = Date.now()): void {
    this.db.prepare(`INSERT INTO sandbox_audit (id, sandbox_id, organization_id, type, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), opts.sandboxId ?? null, opts.organizationId ?? null, type, actor.slice(0, 120), JSON.stringify(opts.detail ?? {}).slice(0, 4000), now);
  }

  auditLog(opts: { organizationId?: string; sandboxId?: string; type?: string; limit?: number } = {}): Array<{ id: string; sandboxId: string | null; organizationId: string | null; type: string; actor: string; detail: Record<string, unknown>; at: number }> {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.organizationId) { where.push("organization_id = ?"); args.push(opts.organizationId); }
    if (opts.sandboxId) { where.push("sandbox_id = ?"); args.push(opts.sandboxId); }
    if (opts.type) { where.push("type = ?"); args.push(opts.type); }
    args.push(Math.min(500, opts.limit ?? 100));
    return (this.db.prepare(`SELECT * FROM sandbox_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`).all(...args) as any[])
      .map((r) => ({ id: r.id, sandboxId: r.sandbox_id, organizationId: r.organization_id, type: r.type, actor: r.actor, detail: JSON.parse(r.detail || "{}"), at: r.at }));
  }

  countAudit(type: string, sinceMs: number, now = Date.now()): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM sandbox_audit WHERE type = ? AND at >= ?`).get(type, now - sinceMs) as any).n;
  }

  // ── policy expansion requests ────────────────────────────────────────
  requestPolicy(input: { sandboxId: string | null; runId: string; organizationId: string; template: string; params?: Record<string, string[]>; reason?: string; requestedBy: string }, now = Date.now()): PolicyRequest {
    const dup = this.db.prepare(`SELECT id FROM sandbox_policy_requests WHERE run_id = ? AND template = ? AND params = ? AND status = 'pending'`)
      .get(input.runId, input.template, JSON.stringify(input.params ?? {})) as any;
    if (dup) return this.policyRequest(dup.id)!;
    const id = `spr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.db.prepare(`INSERT INTO sandbox_policy_requests (id, sandbox_id, run_id, organization_id, template, params, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.sandboxId, input.runId, input.organizationId, input.template, JSON.stringify(input.params ?? {}), String(input.reason ?? "").slice(0, 500), input.requestedBy, now);
    return this.policyRequest(id)!;
  }

  policyRequest(id: string): PolicyRequest | null {
    const r = this.db.prepare(`SELECT * FROM sandbox_policy_requests WHERE id = ?`).get(id) as any;
    if (!r) return null;
    return {
      id: r.id, sandboxId: r.sandbox_id, runId: r.run_id, organizationId: r.organization_id, template: r.template,
      params: JSON.parse(r.params || "{}"), reason: r.reason, status: r.status, requestedBy: r.requested_by,
      decidedBy: r.decided_by, createdAt: r.created_at, decidedAt: r.decided_at, appliedAt: r.applied_at,
    };
  }

  policyRequests(opts: { organizationId?: string; status?: string; runId?: string; limit?: number } = {}): PolicyRequest[] {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.organizationId) { where.push("organization_id = ?"); args.push(opts.organizationId); }
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    if (opts.runId) { where.push("run_id = ?"); args.push(opts.runId); }
    args.push(Math.min(200, opts.limit ?? 50));
    return (this.db.prepare(`SELECT id FROM sandbox_policy_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args) as any[])
      .map((r) => this.policyRequest(r.id)!);
  }

  /** Human decision. The requester (the model) can never decide its own request. */
  decidePolicy(id: string, approve: boolean, actor: string, now = Date.now()): PolicyRequest | null {
    const cur = this.policyRequest(id);
    if (!cur || cur.status !== "pending") return cur;
    if (actor === cur.requestedBy || /^(model|agent|run):/.test(actor)) throw new Error("A policy request can only be decided by a person.");
    this.db.prepare(`UPDATE sandbox_policy_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`).run(approve ? "approved" : "denied", actor, now, id);
    return this.policyRequest(id);
  }

  markPolicyApplied(id: string, ok: boolean, now = Date.now()): void {
    this.db.prepare(`UPDATE sandbox_policy_requests SET status = ?, applied_at = ? WHERE id = ? AND status = 'approved'`).run(ok ? "applied" : "failed", now, id);
  }

  /** The next approved-but-unapplied request for a run (delivered to the worker with the next tool poll). */
  nextApproved(runId: string): PolicyRequest | null {
    const r = this.db.prepare(`SELECT id FROM sandbox_policy_requests WHERE run_id = ? AND status = 'approved' ORDER BY decided_at ASC LIMIT 1`).get(runId) as any;
    return r ? this.policyRequest(r.id) : null;
  }

  expireRequests(runId: string): void {
    this.db.prepare(`UPDATE sandbox_policy_requests SET status = 'expired' WHERE run_id = ? AND status IN ('pending','approved')`).run(runId);
  }
}

let instance: SandboxRegistry | null = null;
export function sandboxRegistry(dataDir?: string): SandboxRegistry {
  if (!instance) {
    // Lazy import keeps this module free of the persistence graph in tests.
    const dir = dataDir ?? require("../../persistence/LocalStore").defaultDataDir();
    instance = new SandboxRegistry(path.join(dir, "execution.sqlite"));
  }
  return instance;
}

/** Tests only. */
export function resetSandboxRegistry(): void { instance = null; }
