// apps/backend/src/admin/staffStore.ts
//
// ORVYN platform staff (the Admin Portal) — kept apart from customer
// organizations. An org "owner/admin" is a customer role and never grants
// access to /admin; only a row in platform_staff does.
//
// Tables (auth.db):
//   platform_staff      who is staff and with which role
//   admin_audit         every staff action, append-only (UPDATE/DELETE blocked)
//   support_notes       internal notes on a customer (never shown to them)
//   account_suspensions pause / reactivate history; the open row is the pause
//   org_profiles        CRM fields staff keep for a customer (website, industry…)
//   view_as_sessions    read-only "View as customer" tokens (hash only)
//
// Staff are seeded from ORVYN_SUPER_ADMIN_EMAILS (comma separated) whenever
// that user signs in or the store starts; everything else is managed in the
// Admin Portal (Settings → Staff) and audited.

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultDataDir } from "../persistence/LocalStore";

export type StaffRole = "super_admin" | "support" | "billing" | "readonly";
export const STAFF_ROLES: StaffRole[] = ["super_admin", "support", "billing", "readonly"];

/** What each staff role may do (the server checks this on every admin route). */
export type StaffPermission =
  | "read"            // every admin screen
  | "billing.write"   // plan changes, credit adjustments
  | "support.write"   // notes, password reset, verification email, view as customer
  | "account.suspend" // pause / reactivate
  | "staff.manage"    // add/remove staff
  | "costs.read";     // internal provider costs

const GRANTS: Record<StaffRole, StaffPermission[]> = {
  super_admin: ["read", "billing.write", "support.write", "account.suspend", "staff.manage", "costs.read"],
  billing: ["read", "billing.write", "costs.read"],
  support: ["read", "support.write", "account.suspend"],
  readonly: ["read"],
};

export function can(role: StaffRole | null | undefined, p: StaffPermission): boolean {
  return Boolean(role && GRANTS[role]?.includes(p));
}

export interface StaffMember { userId: string; email: string; name: string | null; role: StaffRole; createdAt: number; createdBy: string | null }
export interface AuditRow { id: string; at: number; actorId: string; actorEmail: string; action: string; tenantId: string | null; detail: Record<string, unknown>; ip: string | null }
export interface SupportNote { id: string; tenantId: string; authorEmail: string; body: string; createdAt: number }
export interface Suspension { tenantId: string; reason: string; category: string; by: string; at: number; liftedAt: number | null; liftedBy: string | null }

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const SUSPEND_CATEGORIES = ["billing", "compliance", "security", "support", "other"] as const;

export class StaffStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "auth.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_staff (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT);
      CREATE TABLE IF NOT EXISTS admin_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
        actor_id TEXT NOT NULL, actor_email TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, detail TEXT NOT NULL DEFAULT '{}', ip TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_audit_tenant ON admin_audit (tenant_id, at);
      CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at);
      CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
      CREATE TABLE IF NOT EXISTS support_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, author_email TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS support_notes_tenant ON support_notes (tenant_id, created_at);
      CREATE TABLE IF NOT EXISTS account_suspensions (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reason TEXT NOT NULL, category TEXT NOT NULL, by_email TEXT NOT NULL,
        at INTEGER NOT NULL, lifted_at INTEGER, lifted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS account_suspensions_tenant ON account_suspensions (tenant_id, lifted_at);
      CREATE TABLE IF NOT EXISTS org_profiles (tenant_id TEXT PRIMARY KEY, website TEXT, industry TEXT, location TEXT, updated_at INTEGER NOT NULL, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS view_as_sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, staff_email TEXT NOT NULL, user_id TEXT NOT NULL, organization_id TEXT NOT NULL, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.seedFromEnv();
  }

  // ---------- staff ----------

  /** ORVYN_SUPER_ADMIN_EMAILS: these accounts are super admins (added when they exist). */
  seedFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const emails = String(env.ORVYN_SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    for (const email of emails) {
      const u = this.db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email) as { id: string } | undefined;
      if (u) this.db.prepare(`INSERT OR IGNORE INTO platform_staff (user_id, role, created_at, created_by) VALUES (?, 'super_admin', ?, 'env:ORVYN_SUPER_ADMIN_EMAILS')`).run(u.id, Date.now());
    }
  }

  roleOf(userId: string): StaffRole | null {
    const r = this.db.prepare(`SELECT role FROM platform_staff WHERE user_id = ?`).get(userId) as { role: string } | undefined;
    return r && (STAFF_ROLES as string[]).includes(r.role) ? (r.role as StaffRole) : null;
  }

  listStaff(): StaffMember[] {
    return (this.db.prepare(`SELECT s.*, u.email, u.name FROM platform_staff s JOIN users u ON u.id = s.user_id ORDER BY s.created_at`).all() as any[])
      .map((r) => ({ userId: r.user_id, email: r.email, name: r.name ?? null, role: r.role, createdAt: r.created_at, createdBy: r.created_by ?? null }));
  }

  setStaff(email: string, role: StaffRole, by: string): StaffMember {
    if (!STAFF_ROLES.includes(role)) throw Object.assign(new Error("Unknown staff role."), { status: 400 });
    const u = this.db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email.trim().toLowerCase()) as { id: string } | undefined;
    if (!u) throw Object.assign(new Error("No ORVYN account uses that email. They need to sign up first."), { status: 404 });
    this.db.prepare(`INSERT INTO platform_staff (user_id, role, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role`).run(u.id, role, Date.now(), by);
    return this.listStaff().find((s) => s.userId === u.id)!;
  }

  removeStaff(userId: string): boolean {
    const supers = this.listStaff().filter((s) => s.role === "super_admin");
    if (supers.length === 1 && supers[0]!.userId === userId) throw Object.assign(new Error("The last super admin can't be removed."), { status: 409 });
    return Number(this.db.prepare(`DELETE FROM platform_staff WHERE user_id = ?`).run(userId).changes) > 0;
  }

  // ---------- audit (append-only) ----------

  audit(e: { actorId: string; actorEmail: string; action: string; tenantId?: string | null; detail?: Record<string, unknown>; ip?: string | null }): AuditRow {
    const row: AuditRow = { id: `aud_${randomUUID()}`, at: Date.now(), actorId: e.actorId, actorEmail: e.actorEmail, action: e.action, tenantId: e.tenantId ?? null, detail: e.detail ?? {}, ip: e.ip ?? null };
    this.db.prepare(`INSERT INTO admin_audit (id, at, actor_id, actor_email, action, tenant_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.at, row.actorId, row.actorEmail, row.action, row.tenantId, JSON.stringify(row.detail).slice(0, 8000), row.ip);
    return row;
  }

  auditLog(opts: { tenantId?: string; action?: string; actor?: string; before?: number; limit?: number } = {}): AuditRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.tenantId) { where.push("tenant_id = ?"); args.push(opts.tenantId); }
    if (opts.action) { where.push("action LIKE ?"); args.push(`${opts.action}%`); }
    if (opts.actor) { where.push("lower(actor_email) LIKE ?"); args.push(`%${opts.actor.toLowerCase()}%`); }
    if (opts.before) { where.push("at < ?"); args.push(opts.before); }
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    return (this.db.prepare(`SELECT * FROM admin_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}`).all(...args) as any[])
      .map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action, tenantId: r.tenant_id, detail: safeJson(r.detail), ip: r.ip }));
  }

  // ---------- support notes ----------

  addNote(tenantId: string, author: { id: string; email: string }, body: string): SupportNote {
    const text = body.trim().slice(0, 5000);
    if (!text) throw Object.assign(new Error("Write the note first."), { status: 400 });
    const n: SupportNote = { id: `note_${randomUUID()}`, tenantId, authorEmail: author.email, body: text, createdAt: Date.now() };
    this.db.prepare(`INSERT INTO support_notes (id, tenant_id, author_id, author_email, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(n.id, tenantId, author.id, author.email, n.body, n.createdAt);
    return n;
  }

  notes(tenantId?: string, limit = 50): SupportNote[] {
    const rows = tenantId
      ? this.db.prepare(`SELECT * FROM support_notes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`).all(tenantId, limit)
      : this.db.prepare(`SELECT * FROM support_notes ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as any[]).map((r) => ({ id: r.id, tenantId: r.tenant_id, authorEmail: r.author_email, body: r.body, createdAt: r.created_at }));
  }

  // ---------- pause / reactivate (data is never touched) ----------

  suspension(tenantId: string): Suspension | null {
    const r = this.db.prepare(`SELECT * FROM account_suspensions WHERE tenant_id = ? AND lifted_at IS NULL ORDER BY at DESC LIMIT 1`).get(tenantId) as any;
    return r ? { tenantId: r.tenant_id, reason: r.reason, category: r.category, by: r.by_email, at: r.at, liftedAt: null, liftedBy: null } : null;
  }

  suspend(tenantId: string, input: { reason: string; category: string }, by: string): Suspension {
    if (this.suspension(tenantId)) throw Object.assign(new Error("This account is already paused."), { status: 409 });
    const category = (SUSPEND_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "other";
    const reason = input.reason.trim().slice(0, 1000);
    if (!reason) throw Object.assign(new Error("Give a reason for pausing the account."), { status: 400 });
    this.db.prepare(`INSERT INTO account_suspensions (id, tenant_id, reason, category, by_email, at) VALUES (?, ?, ?, ?, ?, ?)`).run(`susp_${randomUUID()}`, tenantId, reason, category, by, Date.now());
    return this.suspension(tenantId)!;
  }

  reactivate(tenantId: string, by: string): boolean {
    return Number(this.db.prepare(`UPDATE account_suspensions SET lifted_at = ?, lifted_by = ? WHERE tenant_id = ? AND lifted_at IS NULL`).run(Date.now(), by, tenantId).changes) > 0;
  }

  pausedTenants(): Suspension[] {
    return (this.db.prepare(`SELECT * FROM account_suspensions WHERE lifted_at IS NULL ORDER BY at DESC LIMIT 500`).all() as any[])
      .map((r) => ({ tenantId: r.tenant_id, reason: r.reason, category: r.category, by: r.by_email, at: r.at, liftedAt: null, liftedBy: null }));
  }

  // ---------- CRM profile ----------

  profile(tenantId: string): { website: string | null; industry: string | null; location: string | null } {
    const r = this.db.prepare(`SELECT website, industry, location FROM org_profiles WHERE tenant_id = ?`).get(tenantId) as any;
    return { website: r?.website ?? null, industry: r?.industry ?? null, location: r?.location ?? null };
  }

  saveProfile(tenantId: string, p: { website?: string | null; industry?: string | null; location?: string | null }, by: string): void {
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    const cur = this.profile(tenantId);
    const next = { website: p.website !== undefined ? clean(p.website) : cur.website, industry: p.industry !== undefined ? clean(p.industry) : cur.industry, location: p.location !== undefined ? clean(p.location) : cur.location };
    if (next.website && !/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(next.website.replace(/^https?:\/\//, ""))) throw Object.assign(new Error("That website doesn't look right."), { status: 400 });
    this.db.prepare(`INSERT INTO org_profiles (tenant_id, website, industry, location, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET website = excluded.website, industry = excluded.industry, location = excluded.location, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(tenantId, next.website, next.industry, next.location, Date.now(), by);
  }

  // ---------- read-only "view as customer" ----------

  createViewAs(staff: { id: string; email: string }, target: { userId: string; organizationId: string; tenantId: string }, ttlMs = 30 * 60_000): { token: string; expiresAt: number } {
    const token = `orvview_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    this.db.prepare(`DELETE FROM view_as_sessions WHERE expires_at <= ?`).run(now);
    this.db.prepare(`INSERT INTO view_as_sessions (token_hash, staff_id, staff_email, user_id, organization_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(token), staff.id, staff.email, target.userId, target.organizationId, target.tenantId, now, now + ttlMs);
    return { token, expiresAt: now + ttlMs };
  }

  resolveViewAs(token: string): { staffId: string; staffEmail: string; userId: string; organizationId: string; tenantId: string; expiresAt: number } | null {
    if (!token.startsWith("orvview_")) return null;
    const r = this.db.prepare(`SELECT * FROM view_as_sessions WHERE token_hash = ? AND expires_at > ?`).get(hash(token), Date.now()) as any;
    if (!r) return null;
    // The staff member must still be staff.
    if (!this.roleOf(r.staff_id)) return null;
    return { staffId: r.staff_id, staffEmail: r.staff_email, userId: r.user_id, organizationId: r.organization_id, tenantId: r.tenant_id, expiresAt: r.expires_at };
  }

  endViewAs(token: string): void {
    this.db.prepare(`DELETE FROM view_as_sessions WHERE token_hash = ?`).run(hash(token));
  }
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

let shared: StaffStore | null = null;
export function staffStore(): StaffStore {
  if (!shared) shared = new StaffStore();
  return shared;
}
