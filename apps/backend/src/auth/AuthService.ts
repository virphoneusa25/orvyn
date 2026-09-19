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
    this.db.exec(SCHEMA);
  }

  register(email: string, password: string, name?: string): { user: User; token: string } {
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
    return { user, token: this.createSession(user.id) };
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
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
  }

  userCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any;
    return Number(row?.n ?? 0);
  }

  private createSession(userId: string): string {
    // Expired-session cleanup piggybacks on session creation.
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
    const token = `orvsess_${randomBytes(32).toString("hex")}`;
    this.db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(hashToken(token), userId, Date.now(), Date.now() + SESSION_TTL_MS);
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
