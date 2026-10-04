import { Pool, type PoolClient } from "pg";
import { AUTH_INDEXES, AUTH_TABLES, AUTH_UNIQUE_KEYS } from "./authSchema";
import { authSnapshotFingerprint, validateAuthSnapshot, type AuthSnapshot, type AuthRow } from "./AuthStorageSnapshot";

const LOCK = "SELECT pg_advisory_xact_lock(730021, 2)";

/** Complete authentication migration target. Live auth routing is deliberately not switched here. */
export class PostgresAuthStorage {
  private pool: Pool;
  constructor(url: string) {
    if (!url) throw new Error("Authentication storage requires a PostgreSQL URL");
    this.pool = new Pool({ connectionString:url, max:4, connectionTimeoutMillis:5000,
      statement_timeout:10000, lock_timeout:5000, idleTimeoutMillis:30000 });
  }

  private async transaction<T>(operation: (client:PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(LOCK);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = new Error("Authentication transaction connection failed"); }
      throw error;
    } finally { client.release(discard); }
  }

  async init(): Promise<void> {
    await this.transaction(async client => {
      await client.query("CREATE SCHEMA IF NOT EXISTS orvyn_auth");
      await client.query("CREATE TABLE IF NOT EXISTS orvyn_auth.migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const applied = await client.query("SELECT version FROM orvyn_auth.migrations ORDER BY version");
      if (applied.rows.some(row => row.version !== 1)) throw new Error("Unsupported authentication storage version");
      if (applied.rowCount) return;
      for (const table of AUTH_TABLES) {
        // SQL comes exclusively from the checked-in contract, never from imported files.
        await client.query(table.sql.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+\w+/i,
          `CREATE TABLE orvyn_auth."${table.name}"`).replace(/\bINTEGER\b/g, "BIGINT"));
      }
      for (const sql of AUTH_INDEXES) await client.query(sql.replace(/ON\s+(\w+)/i, 'ON orvyn_auth."$1"'));
      await client.query("CREATE TABLE orvyn_auth.imports(fingerprint TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      await client.query("INSERT INTO orvyn_auth.migrations(version) VALUES (1)");
    });
  }

  private async read(client: PoolClient): Promise<AuthSnapshot> {
    // Keep the cross-table view consistent even if an operator writes outside this repository.
    await client.query(`LOCK TABLE ${AUTH_TABLES.map(table => `orvyn_auth."${table.name}"`).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
    const version = await client.query("SELECT version FROM orvyn_auth.migrations ORDER BY version");
    if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error("Unsupported authentication storage version");
    const columns = await client.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='orvyn_auth'");
    const keys = await client.query(`SELECT c.relname AS table_name,array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
      WHERE n.nspname='orvyn_auth' AND con.contype IN ('p','u') GROUP BY c.relname,con.oid`);
    for (const table of AUTH_TABLES) {
      const actual = columns.rows.filter(row => row.table_name === table.name);
      if (actual.length !== table.columns.length || table.columns.some(column => !actual.some(row =>
        row.column_name === column.name && row.data_type === (column.type === "INTEGER" ? "bigint" : "text") &&
        row.is_nullable === (column.notNull || column.primaryKey ? "NO" : "YES")))) {
        throw new Error(`PostgreSQL authentication schema differs: ${table.name}`);
      }
      const canonical = (values: readonly (readonly string[])[]) => JSON.stringify(values.map(value => JSON.stringify(value)).sort());
      if (canonical(keys.rows.filter(row => row.table_name === table.name).map(row => row.columns)) !== canonical(AUTH_UNIQUE_KEYS[table.name])) {
        throw new Error(`PostgreSQL authentication uniqueness differs: ${table.name}`);
      }
    }
    const snapshot: AuthSnapshot = {};
    for (const table of AUTH_TABLES) {
      const result = await client.query(`SELECT * FROM orvyn_auth."${table.name}"`);
      snapshot[table.name] = result.rows.map(row => {
        const normalized: AuthRow = {};
        for (const column of table.columns) normalized[column.name] = row[column.name] === null ? null :
          column.type === "INTEGER" ? Number(row[column.name]) : row[column.name];
        return normalized;
      });
    }
    validateAuthSnapshot(snapshot);
    return snapshot;
  }

  async verify(snapshot: AuthSnapshot): Promise<{ matches:boolean; fingerprint:string; counts:Record<string,number> }> {
    const fingerprint = authSnapshotFingerprint(snapshot);
    return this.transaction(async client => {
      const stored = await this.read(client);
      return { matches:authSnapshotFingerprint(stored) === fingerprint, fingerprint,
        counts:Object.fromEntries(AUTH_TABLES.map(table => [table.name, stored[table.name].length])) };
    });
  }

  /** Private migration/restore tooling only: the returned records contain account secrets. */
  async exportSnapshot(): Promise<AuthSnapshot> { return this.transaction(client => this.read(client)); }

  /** Seed only an empty target; repeat of identical data is safe, differing data is never overwritten. */
  async importSnapshot(snapshot: AuthSnapshot): Promise<{ imported:boolean; fingerprint:string }> {
    const fingerprint = authSnapshotFingerprint(snapshot);
    return this.transaction(async client => {
      const current = await this.read(client);
      const imported = await client.query("SELECT 1 FROM orvyn_auth.imports LIMIT 1");
      const occupied = imported.rowCount || AUTH_TABLES.some(table => current[table.name].length > 0);
      if (occupied) {
        if (authSnapshotFingerprint(current) !== fingerprint) throw new Error("Authentication target differs; refusing to overwrite existing records");
        return { imported:false, fingerprint };
      }
      for (const table of AUTH_TABLES) {
        const columns = table.columns.map(column => `"${column.name}"`).join(",");
        const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(",");
        for (const row of snapshot[table.name]) await client.query(
          `INSERT INTO orvyn_auth."${table.name}"(${columns}) VALUES (${placeholders})`, table.columns.map(column => row[column.name]));
      }
      if (authSnapshotFingerprint(await this.read(client)) !== fingerprint) throw new Error("Authentication content verification failed");
      await client.query("INSERT INTO orvyn_auth.imports(fingerprint) VALUES ($1)", [fingerprint]);
      return { imported:true, fingerprint };
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
