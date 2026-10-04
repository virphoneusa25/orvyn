// apps/backend/src/persistence/LocalStore.ts
//
// Local-mode persistence on node:sqlite (built into Node ≥ 22.5 — no native
// dependency). One database file per tenant under ORVYN_DATA_DIR (default
// ~/.orvyn/data). Persists what must survive a backend restart:
//
//   - missions + tasks        (Mission Control history, resumable audit trail)
//   - usage events            (billing basis — losing these loses money)
//   - settings                (autonomy profile, per-project tool overrides)
//   - user-added model configs
//
// Run event logs stay in-memory by design: they are a live stream, and the
// durable outcome they produce (mission state, usage) is persisted here.
// The cloud tier replaces this class with PostgreSQL behind the same calls.
//
// Every write is wrapped so a storage failure degrades to in-memory behavior
// with a one-time warning instead of crashing an agent mid-mission.

import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import { tenantPostgresMirror, type TenantMirrorSnapshot } from "./TenantPostgresMirror";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tasks_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  output_chars INTEGER,
  tool_calls INTEGER,
  mission_id TEXT,
  task_id TEXT,
  agent TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS idx_usage_mission ON usage_events (mission_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_root TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, project_root, updated_at);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_root TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  media_type TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_root, created_at);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_kind ON learning_records (kind, created_at);
-- Durable mission resume state: one row per run, rewritten at meaningful steps.
CREATE TABLE IF NOT EXISTS mission_checkpoints (
  run_id TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  phase TEXT,
  updated_at INTEGER NOT NULL
);
-- Canonical preview record per run/workspace: a run's preview URL is never
-- inferred, never shared across projects, and never survives its owner.
CREATE TABLE IF NOT EXISTS preview_environments (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  project_id TEXT,
  workspace_id TEXT,
  run_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_scope ON preview_environments (workspace_id, run_id, updated_at);
-- Content-addressed blobs (screenshots, frames): keyed by sha256, scoped by tenant path.
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  organization_id TEXT,
  project_id TEXT,
  workspace_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_run ON blobs (run_id, created_at);
`;

export function defaultDataDir(): string {
  const explicit = process.env.ORVYN_DATA_DIR?.trim();
  if (explicit) return explicit;
  // Each test process gets its own directory. Sharing ~/.orvyn/data/auth.db
  // across parallel test files is what produced SQLITE_BUSY.
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(), "orvyn-test-data", String(process.pid));
  }
  return path.join(os.homedir(), ".orvyn", "data");
}

/** One canonical preview record per run — a stale or foreign preview can never be resolved through it. */
export function previewEnvironmentKey(runId: string): string {
  return `pv_${runId}`;
}

export interface ArtifactRowInput {
  id: string;
  projectRoot?: string | null;
  runId?: string | null;
  chatId?: string | null;
  kind: string;
  name: string;
  path: string;
  mediaType?: string | null;
  sha256?: string | null;
  size?: number | null;
  sourceTool?: string | null;
  tenantId?: string | null;
  status?: string | null;
  previewable?: boolean;
  downloadable?: boolean;
  userId?: string | null;
  projectId?: string | null;
}

function mapArtifactRow(r: any) {
  return {
    id: String(r.id),
    projectRoot: r.project_root,
    runId: r.run_id,
    chatId: r.chat_id,
    kind: r.kind,
    name: r.name,
    path: r.path,
    mediaType: r.media_type,
    createdAt: Number(r.created_at),
    sha256: r.sha256,
    size: r.size != null ? Number(r.size) : undefined,
    sourceTool: r.source_tool,
    tenantId: r.tenant_id,
    status: r.status,
    updatedAt: r.updated_at != null ? Number(r.updated_at) : undefined,
    previewable: r.previewable,
    downloadable: r.downloadable,
    userId: r.user_id,
    projectId: r.project_id,
  };
}

export class LocalStore {
  private db: DatabaseSync;
  private warned = false;

  constructor(public readonly tenantId: string, dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, `${tenantId}.db`));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.db.exec("CREATE TABLE IF NOT EXISTS billing_outbox (id TEXT PRIMARY KEY, event_json TEXT NOT NULL)");
    this.migrateArtifacts();
    this.migrateLearning();
    if (tenantPostgresMirror.isEnabled()) {
      try { tenantPostgresMirror.backfill(this.tenantId, this.tenantMirrorSnapshot()); }
      catch { tenantPostgresMirror.noteSnapshotFailure(this.tenantId); }
    }
  }

  private migrateArtifacts(): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(artifacts)`).all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      const add = (name: string, def: string) => {
        if (!names.has(name)) this.db.exec(`ALTER TABLE artifacts ADD COLUMN ${name} ${def}`);
      };
      add("sha256", "TEXT");
      add("size", "INTEGER");
      add("chat_id", "TEXT");
      add("source_tool", "TEXT");
      add("tenant_id", "TEXT");
      add("status", "TEXT");
      add("updated_at", "INTEGER");
      add("previewable", "INTEGER");
      add("downloadable", "INTEGER");
      add("user_id", "TEXT");
      add("project_id", "TEXT");
    } catch {
      /* existing DBs without artifacts stay usable */
    }
  }

  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err: any) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`LocalStore: ${what} failed (${err.message}); continuing in-memory.`);
      }
      return undefined;
    }
  }

  // ---------- missions ----------

  saveMission(m: Mission): void {
    const saved = this.guard("saveMission", () =>
      this.db
        .prepare(
          `INSERT INTO missions (id, run_id, project_root, goal, status, review_cycles, created_at, updated_at, tasks_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             review_cycles = excluded.review_cycles,
             updated_at = excluded.updated_at,
             tasks_json = excluded.tasks_json`
        )
        .run(m.id, m.runId, m.projectRoot, m.goal, m.status, m.reviewCycles, m.createdAt, m.updatedAt, JSON.stringify(m.tasks))
    );
    if (saved) tenantPostgresMirror.saveMission(this.tenantId, m);
  }

  loadMissions(limit = 200): Mission[] {
    return (
      this.guard("loadMissions", () => {
        const rows = this.db
          .prepare(`SELECT * FROM missions ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as any[];
        return rows.map((r) => ({
          id: String(r.id),
          runId: String(r.run_id),
          projectRoot: String(r.project_root),
          goal: String(r.goal),
          status: r.status,
          reviewCycles: Number(r.review_cycles),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
          tasks: JSON.parse(String(r.tasks_json)),
        }));
      }) ?? []
    );
  }

  // ---------- usage ----------

  saveUsageEvent(e: UsageEvent): void {
    const saved = this.guard("saveUsageEvent", () =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO usage_events
           (id, ts, model_id, provider, method, duration_ms, ok, error, prompt_tokens, completion_tokens, output_chars, tool_calls, mission_id, task_id, agent, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          e.id,
          e.timestamp,
          e.modelId,
          e.provider,
          e.method,
          e.durationMs,
          e.ok ? 1 : 0,
          e.error ?? null,
          e.promptTokens ?? null,
          e.completionTokens ?? null,
          e.outputChars ?? null,
          e.toolCalls ?? null,
          e.missionId ?? null,
          e.taskId ?? null,
          e.agent ?? null,
          e.source ?? null
        )
    );
    if (saved) tenantPostgresMirror.saveUsage(this.tenantId, e);
  }

  /** Count of model requests since `ts` — the basis for monthly quotas. */
  countUsageSince(ts: number): number {
    return (
      this.guard("countUsageSince", () => {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ?`).get(ts) as any;
        return Number(row?.n ?? 0);
      }) ?? 0
    );
  }

  /** Count of missions started since `ts` — the basis for monthly mission quotas. */
  countMissionsSince(ts: number): number {
    return (
      this.guard("countMissionsSince", () => {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE created_at >= ?`).get(ts) as any;
        return Number(row?.n ?? 0);
      }) ?? 0
    );
  }

  loadRecentUsage(limit = 5000): UsageEvent[] {
    return (
      this.guard("loadRecentUsage", () => {
        const rows = this.db
          .prepare(`SELECT * FROM usage_events ORDER BY ts DESC LIMIT ?`)
          .all(limit) as any[];
        return rows.reverse().map((r) => {
          const e: UsageEvent = {
            id: String(r.id),
            timestamp: Number(r.ts),
            modelId: String(r.model_id),
            provider: String(r.provider),
            method: r.method,
            durationMs: Number(r.duration_ms),
            ok: r.ok === 1,
          };
          if (r.error != null) e.error = String(r.error);
          if (r.prompt_tokens != null) e.promptTokens = Number(r.prompt_tokens);
          if (r.completion_tokens != null) e.completionTokens = Number(r.completion_tokens);
          if (r.output_chars != null) e.outputChars = Number(r.output_chars);
          if (r.tool_calls != null) e.toolCalls = Number(r.tool_calls);
          if (r.mission_id != null) e.missionId = String(r.mission_id);
          if (r.task_id != null) e.taskId = String(r.task_id);
          if (r.agent != null) e.agent = String(r.agent);
          if (r.source != null) e.source = String(r.source);
          return e;
        });
      }) ?? []
    );
  }

  // ---------- settings ----------

  getSetting(key: string): string | null {
    return (
      this.guard("getSetting", () => {
        const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
        return row ? String(row.value) : null;
      }) ?? null
    );
  }

  enqueueBilling(event: UsageEvent, own: boolean): void {
    this.db.prepare("INSERT OR IGNORE INTO billing_outbox (id, event_json) VALUES (?, ?)").run(event.id, JSON.stringify({ event, own }));
  }
  pendingBilling(): Array<{ event: UsageEvent; own: boolean }> {
    return (this.db.prepare("SELECT event_json FROM billing_outbox ORDER BY rowid LIMIT 1000").all() as { event_json: string }[]).map((row) => JSON.parse(row.event_json));
  }
  completeBilling(id: string): void { this.db.prepare("DELETE FROM billing_outbox WHERE id = ?").run(id); }

  setSetting(key: string, value: string): void {
    const saved = this.guard("setSetting", () =>
      this.db
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value)
    );
    if (saved) tenantPostgresMirror.setSetting(this.tenantId, key, value);
  }

  /** Per-project explicit tool permission overrides (the user's last word). */
  getToolOverrides(projectRoot: string): Record<string, string> {
    const raw = this.getSetting(`toolOverrides:${projectRoot}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  setToolOverride(projectRoot: string, tool: string, permission: string): void {
    const all = this.getToolOverrides(projectRoot);
    all[tool] = permission;
    this.setSetting(`toolOverrides:${projectRoot}`, JSON.stringify(all));
  }

  /** Approval grants remembered at the user's requested scope. */
  getToolApprovalGrants(subjectId: string, sessionId: string, projectKey: string): string[] {
    const raw = this.getSetting(`toolApprovalGrants:${subjectId}`);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw) as { always?: string[]; sessions?: Record<string, string[]>; projects?: Record<string, string[]> };
      return [...new Set([...(data.always ?? []), ...(data.sessions?.[sessionId] ?? []), ...(data.projects?.[projectKey] ?? [])])];
    } catch { return []; }
  }

  saveToolApprovalGrant(scope: "session" | "project" | "always", subjectId: string, tool: string, sessionId: string, projectKey: string): void {
    const settingKey = `toolApprovalGrants:${subjectId}`;
    let data: { always: string[]; sessions: Record<string, string[]>; projects: Record<string, string[]> };
    try {
      const parsed = JSON.parse(this.getSetting(settingKey) ?? "{}");
      data = { always: parsed.always ?? [], sessions: parsed.sessions ?? {}, projects: parsed.projects ?? {} };
    } catch { data = { always: [], sessions: {}, projects: {} }; }
    const target = scope === "always" ? data.always : scope === "session" ? (data.sessions[sessionId] ??= []) : (data.projects[projectKey] ??= []);
    if (!target.includes(tool)) target.push(tool);
    this.setSetting(settingKey, JSON.stringify(data));
  }

  clearToolApprovalGrants(subjectId: string, tool: string): void {
    const settingKey = `toolApprovalGrants:${subjectId}`;
    try {
      const parsed = JSON.parse(this.getSetting(settingKey) ?? "{}");
      const strip = (list: unknown) => Array.isArray(list) ? list.filter((name) => name !== tool) : [];
      const sessions = Object.fromEntries(Object.entries(parsed.sessions ?? {}).map(([id, list]) => [id, strip(list)]));
      const projects = Object.fromEntries(Object.entries(parsed.projects ?? {}).map(([id, list]) => [id, strip(list)]));
      this.setSetting(settingKey, JSON.stringify({ always: strip(parsed.always), sessions, projects }));
    } catch { /* malformed settings are already treated as no grants */ }
  }

  // ---------- ORION memory + artifact library ----------

  saveMemory(input: { id: string; scope: "global" | "project"; projectRoot?: string | null; kind: string; title: string; content: string; source?: string | null; pinned?: boolean }): void {
    const now = Date.now();
    this.guard("saveMemory", () => this.db.prepare(
      `INSERT INTO memories (id, scope, project_root, kind, title, content, source, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, project_root=excluded.project_root, kind=excluded.kind,
       title=excluded.title, content=excluded.content, source=excluded.source, pinned=excluded.pinned, updated_at=excluded.updated_at`
    ).run(input.id, input.scope, input.projectRoot ?? null, input.kind, input.title, input.content, input.source ?? null, input.pinned ? 1 : 0, now, now));
  }

  listMemories(projectRoot?: string | null, limit = 200): any[] {
    return this.guard("listMemories", () => this.db.prepare(
      `SELECT * FROM memories WHERE scope='global' OR (scope='project' AND project_root = ?) ORDER BY pinned DESC, updated_at DESC LIMIT ?`
    ).all(projectRoot ?? "", limit).map((r: any) => ({
      id: String(r.id), scope: r.scope, projectRoot: r.project_root, kind: r.kind, title: r.title,
      content: r.content, source: r.source, pinned: r.pinned === 1, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)
    }))) ?? [];
  }

  getMemory(id: string): any | null {
    return this.guard("getMemory", () => { const r:any=this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id); return r ? { id:String(r.id), scope:r.scope, projectRoot:r.project_root, kind:r.kind, title:r.title, content:r.content, source:r.source, pinned:r.pinned===1, createdAt:Number(r.created_at), updatedAt:Number(r.updated_at) } : null; }) ?? null;
  }

  deleteMemory(id: string): void {
    this.guard("deleteMemory", () => this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id));
  }

  saveArtifact(input: ArtifactRowInput): void {
    this.guard("saveArtifact", () => this.writeArtifactRow(input));
  }

  /** Throws on storage failure — required for persist-before-ok. */
  saveArtifactStrict(input: ArtifactRowInput): void {
    this.writeArtifactRow(input);
  }

  private writeArtifactRow(input: ArtifactRowInput): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO artifacts (id, project_root, run_id, kind, name, path, media_type, created_at, sha256, size, chat_id, source_tool, tenant_id, status, updated_at, previewable, downloadable, user_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path=excluded.path, name=excluded.name, media_type=excluded.media_type,
         sha256=excluded.sha256, size=excluded.size, chat_id=excluded.chat_id,
         source_tool=excluded.source_tool, tenant_id=excluded.tenant_id, status=excluded.status,
         updated_at=excluded.updated_at, previewable=excluded.previewable, downloadable=excluded.downloadable,
         run_id=excluded.run_id, user_id=excluded.user_id, project_id=excluded.project_id`
    ).run(
      input.id,
      input.projectRoot ?? null,
      input.runId ?? null,
      input.kind,
      input.name,
      input.path,
      input.mediaType ?? null,
      now,
      input.sha256 ?? null,
      input.size ?? null,
      input.chatId ?? null,
      input.sourceTool ?? null,
      input.tenantId ?? null,
      input.status ?? "ready",
      now,
      input.previewable === false ? 0 : 1,
      input.downloadable === false ? 0 : 1,
      input.userId ?? null,
      input.projectId ?? null
    );
  }

  listArtifacts(projectRoot?: string | null, limit = 200): any[] {
    return this.guard("listArtifacts", () => projectRoot
      ? this.db.prepare(`SELECT * FROM artifacts WHERE project_root = ? ORDER BY created_at DESC LIMIT ?`).all(projectRoot, limit)
      : this.db.prepare(`SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?`).all(limit)
    ) ?? [];
  }

  getArtifact(id: string): any | null {
    return this.guard("getArtifact", () => {
      const r: any = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id);
      return r ? mapArtifactRow(r) : null;
    }) ?? null;
  }

  deleteArtifact(id: string): void {
    this.guard("deleteArtifact", () => this.db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id));
  }

  private migrateLearning(): void {
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS learning_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_learning_kind ON learning_records (kind, created_at)`);
    } catch {
      /* older sqlite */
    }
  }

  saveLearningRecord(input: { id: string; kind: string; payload: unknown }): void {
    this.guard("saveLearningRecord", () =>
      this.db.prepare(
        `INSERT INTO learning_records (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`
      ).run(input.id, input.kind, JSON.stringify(input.payload), Date.now())
    );
  }

  listLearningRecords(kind: string, limit = 80): { id: string; kind: string; payload: unknown; createdAt: number }[] {
    return this.guard("listLearningRecords", () => {
      const rows = this.db.prepare(`SELECT * FROM learning_records WHERE kind = ? ORDER BY created_at DESC LIMIT ?`).all(kind, limit) as any[];
      return rows.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        payload: JSON.parse(String(r.payload_json)),
        createdAt: Number(r.created_at),
      }));
    }) ?? [];
  }

  // ---------- mission checkpoints ----------

  /** One row per run; each meaningful step rewrites it. */
  saveMissionCheckpoint(runId: string, checkpoint: unknown, phase?: string): void {
    this.guard("saveMissionCheckpoint", () =>
      this.db
        .prepare(
          `INSERT INTO mission_checkpoints (run_id, checkpoint_json, phase, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json, phase=excluded.phase, updated_at=excluded.updated_at`
        )
        .run(runId, JSON.stringify(checkpoint), phase ?? null, Date.now())
    );
  }

  loadMissionCheckpoint(runId: string): unknown | null {
    return this.guard("loadMissionCheckpoint", () => {
      const row: any = this.db.prepare(`SELECT checkpoint_json FROM mission_checkpoints WHERE run_id = ?`).get(runId);
      return row ? JSON.parse(String(row.checkpoint_json)) : null;
    }) ?? null;
  }

  deleteMissionCheckpoint(runId: string): void {
    this.guard("deleteMissionCheckpoint", () => this.db.prepare(`DELETE FROM mission_checkpoints WHERE run_id = ?`).run(runId));
  }

  // ---------- canonical preview environments ----------

  savePreviewEnvironment(input: {
    id: string; organizationId?: string | null; projectId?: string | null;
    workspaceId?: string | null; runId: string; url: string; status: string;
  }): void {
    const now = Date.now();
    this.guard("savePreviewEnvironment", () =>
      this.db
        .prepare(
          `INSERT INTO preview_environments (id, organization_id, project_id, workspace_id, run_id, url, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET url=excluded.url, status=excluded.status, updated_at=excluded.updated_at`
        )
        .run(input.id, input.organizationId ?? null, input.projectId ?? null, input.workspaceId ?? null, input.runId, input.url, input.status, now, now)
    );
  }

  /** The preview record owned by THIS run/workspace — never another run's URL. */
  previewEnvironmentFor(runId: string, workspaceId?: string | null): any | null {
    return this.guard("previewEnvironmentFor", () => {
      const row: any = workspaceId
        ? this.db.prepare(`SELECT * FROM preview_environments WHERE run_id = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1`).get(runId, workspaceId)
        : this.db.prepare(`SELECT * FROM preview_environments WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1`).get(runId);
      if (!row) return null;
      return {
        id: String(row.id), organizationId: row.organization_id, projectId: row.project_id,
        workspaceId: row.workspace_id, runId: String(row.run_id), url: String(row.url),
        status: String(row.status), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      };
    }) ?? null;
  }

  setPreviewEnvironmentStatus(id: string, status: string): void {
    this.guard("setPreviewEnvironmentStatus", () =>
      this.db.prepare(`UPDATE preview_environments SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id)
    );
  }

  // ---------- content-addressed blobs ----------


  saveBlobRow(input: {
    key: string; sha256: string; mediaType: string; size: number; path: string;
    organizationId?: string | null; projectId?: string | null;
    workspaceId?: string | null; runId?: string | null;
  }): void {
    this.guard("saveBlobRow", () =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO blobs (key, sha256, media_type, size, path, organization_id, project_id, workspace_id, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(input.key, input.sha256, input.mediaType, input.size, input.path,
          input.organizationId ?? null, input.projectId ?? null, input.workspaceId ?? null, input.runId ?? null, Date.now())
    );
  }

  getBlobRow(key: string): any | null {
    return this.guard("getBlobRow", () => {
      const r: any = this.db.prepare(`SELECT * FROM blobs WHERE key = ?`).get(key);
      if (!r) return null;
      return {
        key: String(r.key), sha256: String(r.sha256), mediaType: String(r.media_type),
        size: Number(r.size), path: String(r.path), organizationId: r.organization_id,
        projectId: r.project_id, workspaceId: r.workspace_id, runId: r.run_id,
        createdAt: Number(r.created_at),
      };
    }) ?? null;
  }

  // ---------- models ----------

  saveModel(config: ModelConfig): void {
    const saved = this.guard("saveModel", () =>
      this.db
        .prepare(`INSERT INTO models (id, config_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`)
        .run(config.id, JSON.stringify(config))
    );
    if (saved) tenantPostgresMirror.saveModel(this.tenantId, config);
  }

  deleteModel(id: string): void {
    const saved = this.guard("deleteModel", () => this.db.prepare(`DELETE FROM models WHERE id = ?`).run(id));
    if (saved) tenantPostgresMirror.deleteModel(this.tenantId, id);
  }

  loadModels(): ModelConfig[] {
    return (
      this.guard("loadModels", () => {
        const rows = this.db.prepare(`SELECT config_json FROM models`).all() as any[];
        return rows.map((r) => JSON.parse(String(r.config_json)) as ModelConfig);
      }) ?? []
    );
  }

  /** Full history for backfill, including rows outside the Reports window. */
  tenantMirrorSnapshot(): TenantMirrorSnapshot {
    const snapshot: TenantMirrorSnapshot = {
      missions: this.loadMissions(2147483647),
      usageEvents: this.loadRecentUsage(2147483647),
      settings: this.db.prepare("SELECT key,value FROM settings ORDER BY key").all() as unknown as Array<{ key: string; value: string }>,
      models: this.loadModels(),
    };
    // Guarded product reads return empty arrays on failure. Never interpret
    // that degraded result as an authoritative empty snapshot for deletion.
    const counts = this.tenantMirrorCounts();
    if (snapshot.missions.length !== counts.missions || snapshot.usageEvents.length !== counts.usage ||
        snapshot.models.length !== counts.models || snapshot.settings.length !== counts.settings) {
      throw new Error("Incomplete SQLite mirror snapshot");
    }
    return snapshot;
  }

  tenantMirrorCounts(): Record<string, number> {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { missions: count("missions"), usage: count("usage_events"), settings: count("settings"), models: count("models") };
  }

  close(): void {
    this.guard("close", () => this.db.close());
  }
}
