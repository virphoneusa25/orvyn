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
// What this deliberately does NOT do yet (cloud tier): email verification,
// password reset, OAuth, organizations/RBAC. Those need an email provider
// and are documented in docs/CLOUD_ARCHITECTURE.md — not faked here.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import * as path from "path";
import * as fs from "fs";
import { defaultDataDir } from "../persistence/LocalStore";
import { LEGAL_VERSION } from "../legal/policy";
import { postgresMirror } from "../persistence/PostgresMirror";

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
CREATE TABLE IF NOT EXISTS legal_acceptances (
  user_id TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user ON legal_acceptances (user_id);
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

export interface LegalAcceptance {
  version: string;
  acceptedAt: number;
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
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.backfillPostgresMirror();
  }

  private backfillPostgresMirror(): void {
    if (!postgresMirror.isEnabled()) return;

    const users = this.db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all() as any[];
    const sessions = this.db.prepare(`SELECT * FROM sessions ORDER BY created_at ASC`).all() as any[];
    const legal = this.db.prepare(`SELECT * FROM legal_acceptances ORDER BY accepted_at ASC`).all() as any[];

    postgresMirror.mirror("backfillAuth", async () => {
      for (const row of users) {
        await postgresMirror.upsertUser({
          id: String(row.id),
          email: String(row.email),
          name: row.name != null ? String(row.name) : null,
          passwordHash: String(row.password_hash),
          createdAt: Number(row.created_at),
        });
      }
      for (const row of legal) {
        await postgresMirror.saveLegalAcceptance(
          String(row.user_id),
          String(row.version),
          Number(row.accepted_at)
        );
      }
      for (const row of sessions) {
        await postgresMirror.upsertSession({
          tokenHash: String(row.token_hash),
          userId: String(row.user_id),
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
        });
      }
    });
  }

  register(
    email: string,
    password: string,
    name?: string,
    legal?: { accepted: boolean; version: string }
  ): { user: User; token: string; legalAcceptance: LegalAcceptance } {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email address");
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    if (!legal?.accepted || legal.version !== LEGAL_VERSION) {
      throw new Error("You must accept the current ORVYN legal terms before creating an account");
    }
    const existing = this.db.prepare(`SELECT id FROM users WHERE email = ?`).get(normalized);
    if (existing) throw new Error("An account with this email already exists");

    const user: User = {
      id: randomUUID(),
      email: normalized,
      name: name?.trim() || null,
      createdAt: Date.now(),
    };
    const passwordHash = hashPassword(password);
    this.db
      .prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, user.email, user.name, passwordHash, user.createdAt);
    postgresMirror.mirror("upsertUser", () =>
      postgresMirror.upsertUser({
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash,
        createdAt: user.createdAt,
      })
    );
    const legalAcceptance = this.recordLegalAcceptance(user.id, LEGAL_VERSION);
    return { user, token: this.createSession(user.id), legalAcceptance };
  }

  login(email: string, password: string): { user: User; token: string } {
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
    return { user, token: this.createSession(user.id) };
  }

  /** Returns the user for a live session token, or null. */
  verify(token: string): User | null {
    if (!token.startsWith("orvsess_")) return null;
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(hashToken(token), Date.now()) as any;
    return row ? rowToUser(row) : null;
  }

  logout(token: string): void {
    const tokenHash = hashToken(token);
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    postgresMirror.mirror("deleteSession", () =>
      postgresMirror.deleteSession(tokenHash)
    );
  }

  recordLegalAcceptance(userId: string, version: string = LEGAL_VERSION): LegalAcceptance {
    if (version !== LEGAL_VERSION) throw new Error("The legal version is not current");
    const acceptedAt = Date.now();
    this.db
      .prepare(`INSERT INTO legal_acceptances (user_id, version, accepted_at) VALUES (?, ?, ?) ON CONFLICT(user_id, version) DO UPDATE SET accepted_at = excluded.accepted_at`)
      .run(userId, version, acceptedAt);
    postgresMirror.mirror("saveLegalAcceptance", () =>
      postgresMirror.saveLegalAcceptance(userId, version, acceptedAt)
    );
    return { version, acceptedAt };
  }

  getLegalAcceptance(userId: string, version: string = LEGAL_VERSION): LegalAcceptance | null {
    const row = this.db
      .prepare(`SELECT version, accepted_at FROM legal_acceptances WHERE user_id = ? AND version = ?`)
      .get(userId, version) as any;
    return row ? { version: String(row.version), acceptedAt: Number(row.accepted_at) } : null;
  }

  private newSessionMaterial(): {
    token: string;
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
  } {
    const token = `orvsess_${randomBytes(32).toString("hex")}`;
    const createdAt = Date.now();
    return {
      token,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS,
    };
  }

  private cachePrimaryUser(user: User, passwordHash: string): void {
    try {
      // PostgreSQL is authoritative in this mode. Remove any stale local row
      // for the same email but a different id before upserting the cache.
      this.db
        .prepare(`DELETE FROM users WHERE email = ? AND id <> ?`)
        .run(user.email, user.id);
      this.db
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             email=excluded.email,
             name=excluded.name,
             password_hash=excluded.password_hash,
             created_at=excluded.created_at`
        )
        .run(user.id, user.email, user.name, passwordHash, user.createdAt);
    } catch (err) {
      console.warn(
        `[postgres-primary-writes] local user cache update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private cachePrimarySession(session: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    try {
      this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
      this.db
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET
             user_id=excluded.user_id,
             created_at=excluded.created_at,
             expires_at=excluded.expires_at`
        )
        .run(
          session.tokenHash,
          session.userId,
          session.createdAt,
          session.expiresAt
        );
    } catch (err) {
      console.warn(
        `[postgres-primary-writes] local session cache update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private cachePrimaryLegalAcceptance(
    userId: string,
    version: string,
    acceptedAt: number
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO legal_acceptances (user_id, version, accepted_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, version) DO UPDATE SET accepted_at=excluded.accepted_at`
        )
        .run(userId, version, acceptedAt);
    } catch (err) {
      console.warn(
        `[postgres-primary-writes] local legal cache update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async registerAsync(
    email: string,
    password: string,
    name?: string,
    legal?: { accepted: boolean; version: string }
  ): Promise<{ user: User; token: string; legalAcceptance: LegalAcceptance }> {
    if (!postgresMirror.isPrimaryWritesEnabled()) {
      const result = this.register(email, password, name, legal);
      if (postgresMirror.isPrimaryReadsEnabled()) await postgresMirror.flush();
      return result;
    }

    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("Invalid email address");
    }
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    if (!legal?.accepted || legal.version !== LEGAL_VERSION) {
      throw new Error(
        "You must accept the current ORVYN legal terms before creating an account"
      );
    }

    const user: User = {
      id: randomUUID(),
      email: normalized,
      name: name?.trim() || null,
      createdAt: Date.now(),
    };
    const passwordHash = hashPassword(password);
    const acceptedAt = Date.now();
    const session = this.newSessionMaterial();

    try {
      await postgresMirror.registerAccount({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          passwordHash,
          createdAt: user.createdAt,
        },
        legal: {
          version: LEGAL_VERSION,
          acceptedAt,
        },
        session: {
          tokenHash: session.tokenHash,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        },
      });
    } catch (err: any) {
      if (err?.code === "23505" || /duplicate key|unique/i.test(String(err?.message ?? ""))) {
        throw new Error("An account with this email already exists");
      }
      throw err;
    }

    // PostgreSQL commit succeeded. Populate the node-local cache without
    // re-mirroring the same writes.
    this.cachePrimaryUser(user, passwordHash);
    this.cachePrimaryLegalAcceptance(user.id, LEGAL_VERSION, acceptedAt);
    this.cachePrimarySession({
      tokenHash: session.tokenHash,
      userId: user.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });

    return {
      user,
      token: session.token,
      legalAcceptance: { version: LEGAL_VERSION, acceptedAt },
    };
  }

  async loginAsync(email: string, password: string): Promise<{ user: User; token: string }> {
    if (!postgresMirror.isPrimaryReadsEnabled()) {
      return this.login(email, password);
    }

    const normalized = email.trim().toLowerCase();
    const f = this.failures.get(normalized);
    if (f && f.count >= MAX_LOGIN_FAILURES && Date.now() - f.firstAt < LOCKOUT_WINDOW_MS) {
      throw new Error("Too many failed attempts — try again later");
    }
    if (f && Date.now() - f.firstAt >= LOCKOUT_WINDOW_MS) {
      this.failures.delete(normalized);
    }

    try {
      const row = await postgresMirror.getUserAuthByEmail(normalized);
      if (!row || !verifyPassword(password, row.passwordHash)) {
        const cur = this.failures.get(normalized) ?? {
          count: 0,
          firstAt: Date.now(),
        };
        this.failures.set(normalized, {
          count: cur.count + 1,
          firstAt: cur.firstAt,
        });
        throw new Error("Invalid email or password");
      }

      this.failures.delete(normalized);
      const user: User = {
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: row.createdAt,
      };

      if (postgresMirror.isPrimaryWritesEnabled()) {
        const session = this.newSessionMaterial();
        await postgresMirror.createPrimarySession({
          tokenHash: session.tokenHash,
          userId: user.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        });
        this.cachePrimaryUser(user, row.passwordHash);
        this.cachePrimarySession({
          tokenHash: session.tokenHash,
          userId: user.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        });
        return { user, token: session.token };
      }

      const token = this.createSession(user.id);
      await postgresMirror.flush();
      return { user, token };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message === "Invalid email or password" ||
        postgresMirror.isPrimaryWritesEnabled() ||
        process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE?.trim() === "0"
      ) {
        throw err;
      }

      console.warn(
        `[postgres-primary-reads] credential read failed; falling back to SQLite: ${message}`
      );
      return this.login(email, password);
    }
  }

  async verifyAsync(token: string): Promise<User | null> {
    if (!postgresMirror.isPrimaryReadsEnabled()) return this.verify(token);
    if (!token.startsWith("orvsess_")) return null;

    try {
      return await postgresMirror.verifySession(hashToken(token));
    } catch (err) {
      if (process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE?.trim() === "0") throw err;
      console.warn(
        `[postgres-primary-reads] session read failed; falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`
      );
      return this.verify(token);
    }
  }

  async logoutAsync(token: string): Promise<void> {
    if (!postgresMirror.isPrimaryWritesEnabled()) {
      this.logout(token);
      if (postgresMirror.isPrimaryReadsEnabled()) await postgresMirror.flush();
      return;
    }

    const tokenHash = hashToken(token);
    await postgresMirror.deleteSession(tokenHash);
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  async getLegalAcceptanceAsync(
    userId: string,
    version: string = LEGAL_VERSION
  ): Promise<LegalAcceptance | null> {
    if (!postgresMirror.isPrimaryReadsEnabled()) {
      return this.getLegalAcceptance(userId, version);
    }
    try {
      return await postgresMirror.getLegalAcceptance(userId, version);
    } catch (err) {
      if (process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE?.trim() === "0") throw err;
      console.warn(
        `[postgres-primary-reads] legal read failed; falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`
      );
      return this.getLegalAcceptance(userId, version);
    }
  }

  async recordLegalAcceptanceAsync(
    userId: string,
    version: string = LEGAL_VERSION
  ): Promise<LegalAcceptance> {
    if (!postgresMirror.isPrimaryWritesEnabled()) {
      const acceptance = this.recordLegalAcceptance(userId, version);
      if (postgresMirror.isPrimaryReadsEnabled()) await postgresMirror.flush();
      return acceptance;
    }

    if (version !== LEGAL_VERSION) {
      throw new Error("The legal version is not current");
    }
    const acceptedAt = Date.now();
    await postgresMirror.saveLegalAcceptance(userId, version, acceptedAt);
    this.cachePrimaryLegalAcceptance(userId, version, acceptedAt);
    return { version, acceptedAt };
  }

  close(): void {
    this.db.close();
  }

  userCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any;
    return Number(row?.n ?? 0);
  }

  parityCounts(): { users: number; sessions: number; legalAcceptances: number } {
    const row = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM legal_acceptances) AS legal_acceptances`
    ).get() as any;
    return {
      users: Number(row?.users ?? 0),
      sessions: Number(row?.sessions ?? 0),
      legalAcceptances: Number(row?.legal_acceptances ?? 0),
    };
  }

  private createSession(userId: string): string {
    // Expired-session cleanup piggybacks on session creation.
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
    const token = `orvsess_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashToken(token);
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(tokenHash, userId, createdAt, expiresAt);
    postgresMirror.mirror("upsertSession", () =>
      postgresMirror.upsertSession({
        tokenHash,
        userId,
        createdAt,
        expiresAt,
      })
    );
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

export const authService = new AuthService();
