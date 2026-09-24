// apps/backend/src/auth/AuthService.ts
//
// Real per-user accounts for local mode (master spec Phase 10, first slice).
// One shared SQLite database (auth.db in ORVYN_DATA_DIR) holds users and
// sessions — it is cross-tenant by nature, unlike the per-tenant LocalStore.
//
// Security posture:
//   - Passwords are hashed with scrypt (N=16384, per-user random salt);
//     the plaintext never touches disk.
//   - Session tokens are 32 random bytes shown to the client once; only
//     their sha256 is stored. Sessions expire after 30 days.
//   - Login is rate-limited in-memory (5 failures / 15 min per email) to
//     slow credential stuffing.
//
// Personal signup creates a Personal Organization (tenant user_<id>).
// Session tokens resolve userId + organizationId + tenantId; client-supplied
// tenant ids are never authoritative. Email verification / password reset
// still need an email provider (docs/CLOUD_ARCHITECTURE.md).

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import * as path from "path";
import * as fs from "fs";
import { defaultDataDir } from "../persistence/LocalStore";
import {
  personalTenantId,
  type OrganizationRecord,
  type OrgRole,
  type Principal,
  type TenantChat,
  type TenantProject,
} from "../identity/principal";
import { isolation404, scopedGet } from "../identity/isolation";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tenant_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS tenant_projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project_root TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_chats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON tenant_projects (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_tenant ON tenant_chats (tenant_id, created_at);
`;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: number;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N }).toString("hex");
  return `scrypt:${SCRYPT_N}:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64, { N: Number(n) });
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  private db: DatabaseSync;
  private failures = new Map<string, { count: number; firstAt: number }>();

  constructor(dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "auth.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrateSessionOrg();
  }

  close(): void {
    this.db.close();
  }

  private migrateSessionOrg(): void {
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN organization_id TEXT`);
    } catch {
      /* already present */
    }
  }

  register(email: string, password: string, name?: string): { user: User; token: string; organization: OrganizationRecord } {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email address");
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    const existing = this.db.prepare(`SELECT id FROM users WHERE email = ?`).get(normalized);
    if (existing) throw new Error("An account with this email already exists");

    const user: User = {
      id: randomUUID(),
      email: normalized,
      name: name?.trim() || null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, user.email, user.name, hashPassword(password), user.createdAt);
    const org = this.ensurePersonalOrganization(user);
    return { user, token: this.createSession(user.id, org.id), organization: org };
  }

  login(email: string, password: string): { user: User; token: string; organization: OrganizationRecord } {
    const normalized = email.trim().toLowerCase();

    const f = this.failures.get(normalized);
    if (f && f.count >= MAX_LOGIN_FAILURES && Date.now() - f.firstAt < LOCKOUT_WINDOW_MS) {
      throw new Error("Too many failed attempts — try again later");
    }
    if (f && Date.now() - f.firstAt >= LOCKOUT_WINDOW_MS) this.failures.delete(normalized);

    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(normalized) as any;
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      const cur = this.failures.get(normalized) ?? { count: 0, firstAt: Date.now() };
      this.failures.set(normalized, { count: cur.count + 1, firstAt: cur.firstAt });
      // Same message for unknown email and wrong password — don't leak which.
      throw new Error("Invalid email or password");
    }
    this.failures.delete(normalized);

    const user = rowToUser(row);
    const org = this.ensurePersonalOrganization(user);
    return { user, token: this.createSession(user.id, org.id), organization: org };
  }

  /** Returns the user for a live session token, or null. */
  verify(token: string): User | null {
    return this.verifyPrincipal(token)?.user ?? null;
  }

  verifyPrincipal(token: string): { user: User; principal: Principal } | null {
    if (!token.startsWith("orvsess_")) return null;
    const row = this.db
      .prepare(
        `SELECT u.*, s.organization_id AS session_org
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(hashToken(token), Date.now()) as any;
    if (!row) return null;
    const user = rowToUser(row);
    const org = this.organizationForSession(user, row.session_org ? String(row.session_org) : undefined);
    if (!org) return null;
    const member = this.db
      .prepare(`SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?`)
      .get(org.id, user.id) as { role?: string } | undefined;
    if (!member) return null;
    return {
      user,
      principal: {
        userId: user.id,
        email: user.email,
        name: user.name,
        organizationId: org.id,
        organizationName: org.name,
        organizationKind: org.kind,
        tenantId: org.tenantId,
        role: (member.role as OrgRole) || "owner",
      },
    };
  }

  ensurePersonalOrganization(user: User): OrganizationRecord {
    const existing = this.db
      .prepare(
        `SELECT o.* FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
         WHERE m.user_id = ? AND o.kind = 'personal'
         ORDER BY o.created_at ASC LIMIT 1`
      )
      .get(user.id) as any;
    if (existing) return rowToOrg(existing);
    const org: OrganizationRecord = {
      id: `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: "Personal",
      kind: "personal",
      tenantId: personalTenantId(user.id),
      createdAt: Date.now(),
    };
    this.db
      .prepare(`INSERT INTO organizations (id, name, kind, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(org.id, org.name, org.kind, org.tenantId, org.createdAt);
    this.db
      .prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
      .run(org.id, user.id, "owner", Date.now());
    return org;
  }

  createOrganization(owner: Principal, name: string, kind: "company" | "personal" = "company"): OrganizationRecord {
    const org: OrganizationRecord = {
      id: `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: name.trim() || "Organization",
      kind,
      tenantId: `org_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      createdAt: Date.now(),
    };
    this.db
      .prepare(`INSERT INTO organizations (id, name, kind, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(org.id, org.name, org.kind, org.tenantId, org.createdAt);
    this.db
      .prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
      .run(org.id, owner.userId, "owner", Date.now());
    return org;
  }

  addOrganizationMember(actor: Principal, organizationId: string, userId: string, role: OrgRole = "member"): void {
    const membership = this.db
      .prepare(`SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?`)
      .get(organizationId, actor.userId) as { role?: string } | undefined;
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    this.db
      .prepare(`INSERT OR REPLACE INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
      .run(organizationId, userId, role, Date.now());
  }

  listOrganizations(userId: string): OrganizationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
         WHERE m.user_id = ? ORDER BY o.created_at ASC`
      )
      .all(userId) as any[];
    return rows.map(rowToOrg);
  }

  private organizationForSession(user: User, organizationId?: string): OrganizationRecord | null {
    if (organizationId) {
      const row = this.db
        .prepare(
          `SELECT o.* FROM organizations o
           JOIN organization_members m ON m.organization_id = o.id
           WHERE o.id = ? AND m.user_id = ?`
        )
        .get(organizationId, user.id) as any;
      if (row) return rowToOrg(row);
    }
    return this.ensurePersonalOrganization(user);
  }

  createProject(principal: Principal, name: string, projectRoot?: string | null): TenantProject {
    const row: TenantProject = {
      id: `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tenantId: principal.tenantId,
      organizationId: principal.organizationId,
      userId: principal.userId,
      name: name.trim() || "Untitled project",
      projectRoot: projectRoot ?? null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO tenant_projects (id, tenant_id, organization_id, user_id, name, project_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.tenantId, row.organizationId, row.userId, row.name, row.projectRoot ?? null, row.createdAt);
    return row;
  }

  listProjects(tenantId: string): TenantProject[] {
    const rows = this.db
      .prepare(`SELECT * FROM tenant_projects WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 80`)
      .all(tenantId) as any[];
    return rows.map(rowToProject);
  }

  getProject(id: string, tenantId: string): TenantProject {
    const row = this.db.prepare(`SELECT * FROM tenant_projects WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as any;
    if (!row) isolation404();
    return scopedGet(rowToProject(row), tenantId);
  }

  createChat(principal: Principal, title: string): TenantChat {
    const row: TenantChat = {
      id: `cht_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tenantId: principal.tenantId,
      organizationId: principal.organizationId,
      userId: principal.userId,
      title: title.trim() || "New chat",
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO tenant_chats (id, tenant_id, organization_id, user_id, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.tenantId, row.organizationId, row.userId, row.title, row.createdAt);
    return row;
  }

  listChats(tenantId: string): TenantChat[] {
    const rows = this.db
      .prepare(`SELECT * FROM tenant_chats WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 80`)
      .all(tenantId) as any[];
    return rows.map(rowToChat);
  }

  getChat(id: string, tenantId: string): TenantChat {
    const row = this.db.prepare(`SELECT * FROM tenant_chats WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as any;
    if (!row) isolation404();
    return scopedGet(rowToChat(row), tenantId);
  }

  logout(token: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
  }

  switchOrganization(token: string, organizationId: string): { token: string; organization: OrganizationRecord; principal: Principal } {
    const session = this.verifyPrincipal(token);
    if (!session) throw Object.assign(new Error("Not signed in"), { status: 401 });
    const org = this.listOrganizations(session.user.id).find((o) => o.id === organizationId);
    if (!org) isolation404();
    this.logout(token);
    const next = this.createSession(session.user.id, org.id);
    const verified = this.verifyPrincipal(next);
    if (!verified) throw new Error("Failed to switch organization");
    return { token: next, organization: org, principal: verified.principal };
  }

  userCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any;
    return Number(row?.n ?? 0);
  }

  private createSession(userId: string, organizationId?: string): string {
    // Expired-session cleanup piggybacks on session creation.
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
    const token = `orvsess_${randomBytes(32).toString("hex")}`;
    this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, organization_id) VALUES (?, ?, ?, ?, ?)`)
      .run(hashToken(token), userId, Date.now(), Date.now() + SESSION_TTL_MS, organizationId ?? null);
    return token;
  }
}

function rowToUser(row: any): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name != null ? String(row.name) : null,
    createdAt: Number(row.created_at),
  };
}

function rowToOrg(row: any): OrganizationRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind === "company" ? "company" : "personal",
    tenantId: String(row.tenant_id),
    createdAt: Number(row.created_at),
  };
}

function rowToProject(row: any): TenantProject {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    name: String(row.name),
    projectRoot: row.project_root != null ? String(row.project_root) : null,
    createdAt: Number(row.created_at),
  };
}

function rowToChat(row: any): TenantChat {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    title: String(row.title ?? "Chat"),
    createdAt: Number(row.created_at),
  };
}

export const authService = new AuthService();
