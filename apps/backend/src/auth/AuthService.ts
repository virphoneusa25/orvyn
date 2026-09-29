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
  emailVerified?: boolean;
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

  constructor(dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "auth.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrateSessionOrg();
    this.migrateVerification();
    this.migrateAccountSecurity();
  }

  /**
   * Sessions you can see and revoke (device, last used), rotation with reuse
   * detection, password reset links, OAuth identities, the desktop's browser
   * sign-in handoff, and a lockout counter that survives restarts.
   */
  private migrateAccountSecurity(): void {
    for (const col of ["id TEXT", "device TEXT", "last_used_at INTEGER", "family TEXT"]) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* present */ }
    }
    try { this.db.exec(`ALTER TABLE users ADD COLUMN password_changed_at INTEGER`); } catch { /* present */ }
    this.db.exec(`
      UPDATE sessions SET id = 'ses_' || lower(hex(randomblob(12))) WHERE id IS NULL;
      UPDATE sessions SET family = id WHERE family IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions (id);
      CREATE TABLE IF NOT EXISTS session_rotations (old_hash TEXT PRIMARY KEY, family TEXT NOT NULL, user_id TEXT NOT NULL, rotated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
      CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, client TEXT NOT NULL, handoff_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_handoffs (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, device TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER, claimed_at INTEGER);
      CREATE TABLE IF NOT EXISTS github_links (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_failures (email TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL);
    `);
  }

  /** Email verification: a column on users plus single-use link tokens (only their hash is stored). */
  private migrateVerification(): void {
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN email_verified_at INTEGER`);
    } catch {
      /* already present */
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_verify_user ON email_verifications (user_id);`);
  }

  /** A single-use verification token for the user's current email (24 h). Older unused links stop working. */
  createEmailVerification(userId: string, now = Date.now()): { token: string; email: string } {
    const row = this.db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as { email?: string } | undefined;
    if (!row?.email) throw new Error("Unknown user");
    this.db.prepare(`UPDATE email_verifications SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, userId);
    const token = `orvver_${randomBytes(32).toString("hex")}`;
    this.db
      .prepare(`INSERT INTO email_verifications (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(hashToken(token), userId, row.email, now, now + 24 * 60 * 60 * 1000);
    return { token, email: row.email };
  }

  /** Consumes a verification link. Returns the verified user, or null for an unknown/expired/used link. */
  verifyEmailToken(token: string, now = Date.now()): User | null {
    if (!token.startsWith("orvver_")) return null;
    const row = this.db
      .prepare(`SELECT * FROM email_verifications WHERE token_hash = ?`)
      .get(hashToken(token)) as { user_id: string; email: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at || row.expires_at <= now) return null;
    const user = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id) as any;
    if (!user || String(user.email) !== row.email) return null;
    this.db.prepare(`UPDATE email_verifications SET used_at = ? WHERE token_hash = ?`).run(now, hashToken(token));
    this.db.prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).run(now, row.user_id);
    return rowToUser(user);
  }

  isEmailVerified(userId: string): boolean {
    const row = this.db.prepare(`SELECT email_verified_at FROM users WHERE id = ?`).get(userId) as { email_verified_at?: number | null } | undefined;
    return Boolean(row?.email_verified_at);
  }

  /** Marks the email as verified by a trusted source (an OAuth provider that verified it). */
  markEmailVerified(userId: string, now = Date.now()): void {
    this.db.prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).run(now, userId);
  }

  /** "Change email" before it is verified. */
  changeUnverifiedEmail(userId: string, email: string): User {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email address");
    if (this.isEmailVerified(userId)) throw new Error("This email is already verified");
    const taken = this.db.prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`).get(normalized, userId);
    if (taken) throw new Error("An account with this email already exists");
    this.db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(normalized, userId);
    this.db.prepare(`UPDATE email_verifications SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(Date.now(), userId);
    return rowToUser(this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId));
  }

  setName(userId: string, name: string): void {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error("Name is required");
    this.db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(clean, userId);
  }

  getUser(userId: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    return row ? rowToUser(row) : null;
  }

  /** The personal tenant's owner (the user whose preferences shape ORION there). */
  userForTenant(tenantId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT m.user_id FROM organizations o JOIN organization_members m ON m.organization_id = o.id
         WHERE o.tenant_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at ASC LIMIT 1`
      )
      .get(tenantId) as { user_id?: string } | undefined;
    return row?.user_id ?? null;
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

  register(email: string, password: string, name?: string, device?: string): { user: User; token: string; organization: OrganizationRecord } {
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
    return { user, token: this.createSession(user.id, org.id, device), organization: org };
  }

  login(email: string, password: string, device?: string): { user: User; token: string; organization: OrganizationRecord } {
    const normalized = email.trim().toLowerCase();
    const now = Date.now();
    const f = this.db.prepare(`SELECT count, first_at FROM login_failures WHERE email = ?`).get(normalized) as { count: number; first_at: number } | undefined;
    if (f && now - f.first_at >= LOCKOUT_WINDOW_MS) this.db.prepare(`DELETE FROM login_failures WHERE email = ?`).run(normalized);
    else if (f && f.count >= MAX_LOGIN_FAILURES) throw new Error("Too many failed attempts — try again later");

    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(normalized) as any;
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      this.db.prepare(
        `INSERT INTO login_failures (email, count, first_at) VALUES (?, 1, ?)
         ON CONFLICT(email) DO UPDATE SET count = count + 1`,
      ).run(normalized, now);
      // Same message for unknown email and wrong password — don't leak which.
      throw new Error("Invalid email or password");
    }
    this.db.prepare(`DELETE FROM login_failures WHERE email = ?`).run(normalized);

    const user = rowToUser(row);
    const org = this.ensurePersonalOrganization(user);
    return { user, token: this.createSession(user.id, org.id, device), organization: org };
  }

  /** Returns the user for a live session token, or null. */
  verify(token: string): User | null {
    return this.verifyPrincipal(token)?.user ?? null;
  }

  verifyPrincipal(token: string): { user: User; principal: Principal } | null {
    if (!token.startsWith("orvsess_")) return null;
    const hash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT u.*, s.organization_id AS session_org, s.id AS session_id, s.last_used_at AS session_last_used
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(hash, Date.now()) as any;
    if (!row) {
      // A token that was already rotated away is being used again: someone
      // holds a stolen copy. End every session in that family.
      // Requests already in flight when the app rotated carry the old token
      // for a moment: refuse them, but only a reuse after the grace window
      // counts as theft.
      const reused = this.db.prepare(`SELECT family, rotated_at FROM session_rotations WHERE old_hash = ?`).get(hash) as { family: string; rotated_at: number } | undefined;
      const grace = Number(process.env.ORVYN_SESSION_ROTATION_GRACE_MS ?? 60_000);
      if (reused && Date.now() - Number(reused.rotated_at) > grace) {
        this.db.prepare(`DELETE FROM sessions WHERE family = ?`).run(reused.family);
        console.warn(JSON.stringify({ event: "auth.session.reuse_detected", family: reused.family }));
      }
      return null;
    }
    if (!row.session_last_used || Date.now() - Number(row.session_last_used) > 5 * 60_000) {
      this.db.prepare(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`).run(Date.now(), hash);
    }
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

  private createSession(userId: string, organizationId?: string, device?: string, family?: string): string {
    // Expired-session cleanup piggybacks on session creation.
    const now = Date.now();
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
    this.db.prepare(`DELETE FROM session_rotations WHERE rotated_at <= ?`).run(now - SESSION_TTL_MS);
    const token = `orvsess_${randomBytes(32).toString("hex")}`;
    const id = `ses_${randomBytes(12).toString("hex")}`;
    this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, organization_id, id, device, last_used_at, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hashToken(token), userId, now, now + SESSION_TTL_MS, organizationId ?? null, id, cleanDevice(device), now, family ?? id);
    return token;
  }

  // ---------- sessions you can see and end ----------

  listSessions(userId: string, currentToken?: string): { id: string; device: string; createdAt: number; lastUsedAt: number; current: boolean }[] {
    const current = currentToken ? hashToken(currentToken) : "";
    return (this.db.prepare(`SELECT token_hash, id, device, created_at, last_used_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`).all(userId, Date.now()) as any[])
      .map((r) => ({ id: String(r.id), device: String(r.device ?? "Unknown device"), createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at ?? r.created_at), current: r.token_hash === current }));
  }

  revokeSession(userId: string, sessionId: string): boolean {
    return Number(this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id = ?`).run(userId, sessionId).changes) > 0;
  }

  /** Sign out everywhere (optionally keeping the session making the request). */
  logoutAll(userId: string, keepToken?: string): number {
    const keep = keepToken ? hashToken(keepToken) : "";
    return Number(this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).run(userId, keep).changes);
  }

  /**
   * Swap a session token for a fresh one (same device, same family). The old
   * token stops working at once; presenting it again ends the whole family.
   */
  rotateSession(token: string): string | null {
    const hash = hashToken(token);
    const row = this.db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`).get(hash, Date.now()) as any;
    if (!row) { this.verifyPrincipal(token); return null; }
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hash);
    this.db.prepare(`INSERT OR REPLACE INTO session_rotations (old_hash, family, user_id, rotated_at) VALUES (?, ?, ?, ?)`).run(hash, String(row.family ?? row.id), String(row.user_id), Date.now());
    return this.createSession(String(row.user_id), row.organization_id ? String(row.organization_id) : undefined, row.device ?? undefined, String(row.family ?? row.id));
  }

  // ---------- password reset ----------

  /** A single-use reset link (1 h). null when no such account (the caller answers the same either way). */
  createPasswordReset(email: string, now = Date.now()): { token: string; user: User } | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim().toLowerCase()) as any;
    if (!row) return null;
    this.db.prepare(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(now, row.id);
    const token = `orvrst_${randomBytes(32).toString("hex")}`;
    this.db.prepare(`INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(hashToken(token), row.id, now, now + 60 * 60_000);
    return { token, user: rowToUser(row) };
  }

  /** Sets a new password from a reset link; every existing session ends. */
  resetPassword(token: string, password: string, now = Date.now()): User {
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    const row = this.db.prepare(`SELECT * FROM password_resets WHERE token_hash = ?`).get(hashToken(token)) as any;
    if (!row || row.used_at || Number(row.expires_at) < now) throw new Error("This reset link has expired. Request a new one.");
    this.db.prepare(`UPDATE password_resets SET used_at = ? WHERE token_hash = ?`).run(now, hashToken(token));
    this.db.prepare(`UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?`).run(hashPassword(password), now, row.user_id);
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id);
    this.db.prepare(`DELETE FROM login_failures WHERE email = (SELECT email FROM users WHERE id = ?)`).run(row.user_id);
    // Following the emailed link proved the address.
    this.markEmailVerified(String(row.user_id), now);
    return this.getUser(String(row.user_id))!;
  }

  // ---------- sign in with Google / GitHub ----------

  /** Remembers an OAuth start (state → PKCE verifier) for 10 minutes; single use. */
  saveOAuthState(input: { state: string; provider: string; verifier: string; client: string; handoffId?: string }, now = Date.now()): void {
    this.db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`).run(now);
    this.db.prepare(`INSERT INTO oauth_states (state_hash, provider, verifier, client, handoff_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hashToken(input.state), input.provider, input.verifier, input.client, input.handoffId ?? null, now, now + 10 * 60_000);
  }

  takeOAuthState(state: string, provider: string, now = Date.now()): { verifier: string; client: string; handoffId: string | null } | null {
    const row = this.db.prepare(`SELECT * FROM oauth_states WHERE state_hash = ?`).get(hashToken(state)) as any;
    this.db.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).run(hashToken(state));
    if (!row || row.provider !== provider || Number(row.expires_at) < now) return null;
    return { verifier: String(row.verifier), client: String(row.client), handoffId: row.handoff_id ? String(row.handoff_id) : null };
  }

  /**
   * The ORVYN account for a provider identity. Known identity → its user.
   * Otherwise an account with the same email is linked ONLY when the
   * provider says the email is verified; else a new account is created.
   */
  userForOAuth(input: { provider: string; subject: string; email: string; emailVerified: boolean; name?: string | null }, now = Date.now()): User {
    const known = this.db.prepare(`SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?`).get(input.provider, input.subject) as { user_id: string } | undefined;
    if (known) {
      const u = this.getUser(known.user_id);
      if (u) return u;
    }
    const email = input.email.trim().toLowerCase();
    if (!input.emailVerified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Your account there has no verified email address.");
    let row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as any;
    if (!row) {
      const id = randomUUID();
      // No password: this account signs in with the provider (or sets one via reset).
      this.db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, email, input.name?.trim() || null, `oauth:${randomBytes(16).toString("hex")}`, now);
      row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    }
    this.db.prepare(`INSERT OR IGNORE INTO oauth_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.provider, input.subject, row.id, email, now);
    this.markEmailVerified(String(row.id), now);
    const user = rowToUser(row);
    this.ensurePersonalOrganization(user);
    return this.getUser(user.id)!;
  }

  /** A session for a user who signed in through a provider (web return, or the desktop handoff). */
  sessionFor(userId: string, device?: string): { token: string; organization: OrganizationRecord } {
    const user = this.getUser(userId);
    if (!user) throw new Error("Unknown account");
    const org = this.ensurePersonalOrganization(user);
    return { token: this.createSession(user.id, org.id, device), organization: org };
  }

  // ---------- "Connect GitHub" links (10 minutes, single use) ----------

  createGithubLink(userId: string, now = Date.now()): string {
    this.db.prepare(`DELETE FROM github_links WHERE expires_at <= ?`).run(now);
    const id = randomBytes(24).toString("base64url");
    this.db.prepare(`INSERT INTO github_links (id_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(hashToken(id), userId, now + 10 * 60_000);
    return id;
  }

  githubLinkValid(id: string, now = Date.now()): boolean {
    const row = this.db.prepare(`SELECT expires_at FROM github_links WHERE id_hash = ?`).get(hashToken(id)) as { expires_at: number } | undefined;
    return Boolean(row && Number(row.expires_at) > now);
  }

  takeGithubLink(id: string, now = Date.now()): string | null {
    const row = this.db.prepare(`SELECT user_id, expires_at FROM github_links WHERE id_hash = ?`).get(hashToken(id)) as { user_id: string; expires_at: number } | undefined;
    this.db.prepare(`DELETE FROM github_links WHERE id_hash = ?`).run(hashToken(id));
    return row && Number(row.expires_at) > now ? String(row.user_id) : null;
  }

  // ---------- desktop sign-in through the browser ----------
  //
  // The desktop picks a random handoff id and a secret verifier, and opens
  // the browser with the id and SHA-256(verifier). The browser signs in; the
  // server marks the handoff complete. The desktop then claims it with the
  // verifier — once — and only then is a session created. No session token
  // ever appears in a URL.

  startHandoff(id: string, challenge: string, now = Date.now()): void {
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("Invalid sign-in request");
    this.db.prepare(`DELETE FROM desktop_handoffs WHERE expires_at <= ?`).run(now);
    this.db.prepare(`INSERT OR IGNORE INTO desktop_handoffs (id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(id, challenge, now, now + 10 * 60_000);
  }

  completeHandoff(id: string, userId: string, now = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE desktop_handoffs SET user_id = ?, completed_at = ? WHERE id = ? AND completed_at IS NULL AND expires_at > ?`).run(userId, now, id, now).changes) > 0;
  }

  /** "pending" until the browser finishes; a session token exactly once; then gone. */
  claimHandoff(id: string, verifier: string, device?: string, now = Date.now()): { status: "pending" } | { status: "ok"; token: string } | { status: "invalid" } {
    const row = this.db.prepare(`SELECT * FROM desktop_handoffs WHERE id = ?`).get(id) as any;
    if (!row || Number(row.expires_at) < now || row.claimed_at) return { status: "invalid" };
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const a = Buffer.from(challenge);
    const b = Buffer.from(String(row.challenge));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: "invalid" };
    if (!row.completed_at || !row.user_id) return { status: "pending" };
    const claimed = this.db.prepare(`UPDATE desktop_handoffs SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL`).run(now, id);
    if (Number(claimed.changes) === 0) return { status: "invalid" };
    return { status: "ok", token: this.sessionFor(String(row.user_id), device ?? "ORVYN Desktop").token };
  }
}

/** A short, printable device label (from the client or its User-Agent). */
export function cleanDevice(device?: string | null): string {
  const d = String(device ?? "").replace(/[^\w .,()/;:+-]/g, "").trim();
  if (!d) return "Unknown device";
  if (/Electron|ORVYN/i.test(d)) return /Windows/i.test(d) ? "ORVYN Desktop · Windows" : /Mac OS/i.test(d) ? "ORVYN Desktop · macOS" : /Linux/i.test(d) ? "ORVYN Desktop · Linux" : "ORVYN Desktop";
  const browser = /Edg\//.test(d) ? "Edge" : /Chrome\//.test(d) ? "Chrome" : /Firefox\//.test(d) ? "Firefox" : /Safari\//.test(d) ? "Safari" : "";
  const os = /Windows/i.test(d) ? "Windows" : /iPhone|iPad/i.test(d) ? "iOS" : /Android/i.test(d) ? "Android" : /Mac OS/i.test(d) ? "macOS" : /Linux/i.test(d) ? "Linux" : "";
  return browser || os ? [browser, os].filter(Boolean).join(" · ") : d.slice(0, 60);
}

function rowToUser(row: any): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name != null ? String(row.name) : null,
    createdAt: Number(row.created_at),
    emailVerified: row.email_verified_at != null,
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
