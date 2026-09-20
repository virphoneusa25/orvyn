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
`;

export function defaultDataDir(): string {
  return process.env.ORVYN_DATA_DIR?.trim() || path.join(os.homedir(), ".orvyn", "data");
}

export class LocalStore {
  private db: DatabaseSync;
  private warned = false;

  constructor(tenantId: string, dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, `${tenantId}.db`));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
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
    this.guard("saveMission", () =>
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
    this.guard("saveUsageEvent", () =>
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

  setSetting(key: string, value: string): void {
    this.guard("setSetting", () =>
      this.db
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value)
    );
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

  saveArtifact(input: { id: string; projectRoot?: string | null; runId?: string | null; kind: string; name: string; path: string; mediaType?: string | null }): void {
    this.guard("saveArtifact", () => this.db.prepare(
      `INSERT INTO artifacts (id, project_root, run_id, kind, name, path, media_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, name=excluded.name, media_type=excluded.media_type`
    ).run(input.id, input.projectRoot ?? null, input.runId ?? null, input.kind, input.name, input.path, input.mediaType ?? null, Date.now()));
  }

  listArtifacts(projectRoot?: string | null, limit = 200): any[] {
    return this.guard("listArtifacts", () => projectRoot
      ? this.db.prepare(`SELECT * FROM artifacts WHERE project_root = ? ORDER BY created_at DESC LIMIT ?`).all(projectRoot, limit)
      : this.db.prepare(`SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?`).all(limit)
    ) ?? [];
  }

  // ---------- models ----------

  saveModel(config: ModelConfig): void {
    this.guard("saveModel", () =>
      this.db
        .prepare(`INSERT INTO models (id, config_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`)
        .run(config.id, JSON.stringify(config))
    );
  }

  deleteModel(id: string): void {
    this.guard("deleteModel", () => this.db.prepare(`DELETE FROM models WHERE id = ?`).run(id));
  }

  loadModels(): ModelConfig[] {
    return (
      this.guard("loadModels", () => {
        const rows = this.db.prepare(`SELECT config_json FROM models`).all() as any[];
        return rows.map((r) => JSON.parse(String(r.config_json)) as ModelConfig);
      }) ?? []
    );
  }

  close(): void {
    this.guard("close", () => this.db.close());
  }
}
