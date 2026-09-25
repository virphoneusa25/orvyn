// apps/backend/src/sessions/WorkSessionStore.ts
//
// The durable WorkSession: one record that says "this conversation worked in
// this workspace and had these runs". Every chat gets a session; every run
// started from that chat belongs to it. The backend is authoritative; the
// desktop's orvyn-chats.json is only a cache.
//
// Stored in SQLite under ORVYN_DATA_DIR (a persistent volume on ORVYN Cloud),
// one file per tenant, so closing the app or redeploying the backend changes
// nothing about a session.
//
// Workspaces get stable ids too: the same folder always maps to the same
// workspaceId/projectId, so a session can be reattached even if its path is
// later shown differently.

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";

export type WorkSessionStatus = "active" | "idle" | "archived";

export interface WorkSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  title: string;
  projectId: string | null;
  workspaceId: string | null;
  projectRoot: string | null;
  runIds: string[];
  activeRunId: string | null;
  status: WorkSessionStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_key TEXT NOT NULL UNIQUE,
  project_root TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_sessions (
  session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  project_root TEXT,
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  active_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON work_sessions (tenant_id, updated_at);
CREATE TABLE IF NOT EXISTS session_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);
`;

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

/** Same folder, same key: case and slashes do not make a new workspace. */
export function rootKey(projectRoot: string): string {
  const r = projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(r) || r.startsWith("//") ? r.toLowerCase() : r;
}

interface Row {
  session_id: string; tenant_id: string; user_id: string; title: string; project_id: string | null;
  workspace_id: string | null; project_root: string | null; run_ids_json: string; active_run_id: string | null;
  status: string; pinned: number; created_at: number; updated_at: number;
}

function fromRow(r: Row): WorkSession {
  let runIds: string[] = [];
  try { runIds = JSON.parse(r.run_ids_json); } catch { /* corrupt → empty */ }
  return {
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    title: r.title,
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    projectRoot: r.project_root,
    runIds,
    activeRunId: r.active_run_id,
    status: (r.status as WorkSessionStatus) || "active",
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class WorkSessionStore {
  private db: DatabaseSync;

  constructor(private readonly tenantId: string, dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, `${tenantId}-sessions.db`));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** The stable workspace (and project) for a folder; created the first time it is seen. */
  workspaceFor(projectRoot: string): { workspaceId: string; projectId: string } {
    const key = rootKey(projectRoot);
    const hit = this.db.prepare(`SELECT workspace_id, project_id FROM workspaces WHERE root_key = ?`).get(key) as { workspace_id: string; project_id: string } | undefined;
    if (hit) return { workspaceId: hit.workspace_id, projectId: hit.project_id };
    const w = { workspaceId: id("ws"), projectId: id("proj") };
    this.db.prepare(`INSERT INTO workspaces (workspace_id, project_id, root_key, project_root, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(w.workspaceId, w.projectId, key, projectRoot, Date.now());
    return w;
  }

  create(input: { title: string; userId?: string; projectRoot?: string | null }): WorkSession {
    const now = Date.now();
    const root = input.projectRoot?.trim() || null;
    const ws = root ? this.workspaceFor(root) : null;
    const session: WorkSession = {
      sessionId: id("sess"),
      tenantId: this.tenantId,
      userId: input.userId ?? "",
      title: (input.title || "New conversation").slice(0, 120),
      projectId: ws?.projectId ?? null,
      workspaceId: ws?.workspaceId ?? null,
      projectRoot: root,
      runIds: [],
      activeRunId: null,
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO work_sessions (session_id, tenant_id, user_id, title, project_id, workspace_id, project_root, run_ids_json, active_run_id, status, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'active', 0, ?, ?)`
    ).run(session.sessionId, this.tenantId, session.userId, session.title, session.projectId, session.workspaceId, session.projectRoot, now, now);
    return session;
  }

  get(sessionId: string): WorkSession | undefined {
    const r = this.db.prepare(`SELECT * FROM work_sessions WHERE session_id = ? AND tenant_id = ?`).get(sessionId, this.tenantId) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  list(limit = 200): WorkSession[] {
    const rows = this.db.prepare(`SELECT * FROM work_sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`).all(this.tenantId, limit) as unknown as Row[];
    return rows.map(fromRow);
  }

  sessionOfRun(runId: string): WorkSession | undefined {
    const r = this.db.prepare(`SELECT session_id FROM session_runs WHERE run_id = ?`).get(runId) as { session_id: string } | undefined;
    return r ? this.get(r.session_id) : undefined;
  }

  /** A run joins the session; it becomes the session's active run. */
  attachRun(sessionId: string, runId: string, projectRoot?: string | null): WorkSession | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    const runIds = s.runIds.includes(runId) ? s.runIds : [...s.runIds, runId];
    let { workspaceId, projectId } = s;
    let root = s.projectRoot;
    if (!workspaceId && projectRoot?.trim()) {
      const ws = this.workspaceFor(projectRoot);
      workspaceId = ws.workspaceId;
      projectId = ws.projectId;
      root = projectRoot.trim();
    }
    const now = Date.now();
    this.db.prepare(
      `UPDATE work_sessions SET run_ids_json = ?, active_run_id = ?, workspace_id = ?, project_id = ?, project_root = ?, status = CASE WHEN status = 'archived' THEN status ELSE 'active' END, updated_at = ? WHERE session_id = ?`
    ).run(JSON.stringify(runIds), runId, workspaceId, projectId, root, now, sessionId);
    this.db.prepare(`INSERT OR REPLACE INTO session_runs (run_id, session_id) VALUES (?, ?)`).run(runId, sessionId);
    return this.get(sessionId);
  }

  update(sessionId: string, patch: { title?: string; status?: WorkSessionStatus; pinned?: boolean }): WorkSession | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    const title = patch.title !== undefined ? String(patch.title).slice(0, 120) || s.title : s.title;
    const status = patch.status && ["active", "idle", "archived"].includes(patch.status) ? patch.status : s.status;
    const pinned = patch.pinned !== undefined ? patch.pinned : s.pinned;
    this.db.prepare(`UPDATE work_sessions SET title = ?, status = ?, pinned = ?, updated_at = ? WHERE session_id = ?`)
      .run(title, status, pinned ? 1 : 0, Date.now(), sessionId);
    return this.get(sessionId);
  }

  delete(sessionId: string): boolean {
    const r = this.db.prepare(`DELETE FROM work_sessions WHERE session_id = ? AND tenant_id = ?`).run(sessionId, this.tenantId);
    this.db.prepare(`DELETE FROM session_runs WHERE session_id = ?`).run(sessionId);
    return Number(r.changes) > 0;
  }
}
