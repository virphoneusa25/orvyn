import { Client } from "pg";

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_identity",
    sql: `
CREATE TABLE IF NOT EXISTS identity_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS identity_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tenant_id TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS identity_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project_root TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_chats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_projects_tenant ON identity_projects (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_chats_tenant ON identity_chats (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_sessions_user ON identity_sessions (user_id);
`,
  },
];

export async function migratePostgresIdentity(url = process.env.ORVYN_PG_URL): Promise<{ applied: string[]; database: string }> {
  if (!url) return { applied: [], database: "not_configured" };
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS identity_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      const exists = await client.query(`SELECT 1 FROM identity_migrations WHERE id = $1`, [m.id]);
      if (exists.rowCount) continue;
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query(`INSERT INTO identity_migrations (id) VALUES ($1)`, [m.id]);
      await client.query("COMMIT");
      applied.push(m.id);
    }
    const db = await client.query("SELECT current_database() AS name");
    return { applied, database: String(db.rows[0]?.name ?? "unknown") };
  } finally {
    await client.end();
  }
}
