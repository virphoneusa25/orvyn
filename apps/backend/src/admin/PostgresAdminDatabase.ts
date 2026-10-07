import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { authSql } from "../auth/PostgresAuthDatabase";
import { sessionSchema, decodeSessionText } from "../sessions/PostgresSessionDatabase";

/** Translate only the reporting queries shared with the local implementation. */
export function adminSql(sql: string): string {
  sql = sql.replace(/\bb\./g, "orvyn_billing.").replace(/\bp\.(stripe_\w+)/g, "orvyn_payments.$1");
  sql = sql.replace(/substr\(datetime\(created_at\/1000,'unixepoch'\),1,10\)/g,
    "to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
  // SQLite permits arbitrary joined columns in GROUP BY; select the earliest membership explicitly.
  sql = sql.replace("SELECT u.id, u.email, u.name, o.tenant_id, o.name AS org FROM users u", "SELECT DISTINCT ON (u.id) u.id, u.email, u.name, o.tenant_id, o.name AS org FROM users u")
    .replace("GROUP BY u.id LIMIT ?", "ORDER BY u.id, m.created_at, m.organization_id LIMIT ?");
  sql = sql.replace("GROUP BY provider, model, lane, type", "GROUP BY COALESCE(provider,'unknown'), COALESCE(model,'unknown'), COALESCE(lane,'auto'), type");
  sql = sql.replace("GROUP BY account_id) WHERE first", "GROUP BY account_id) AS first_grants WHERE first");
  return authSql(sql);
}

type Frame = { client: PoolClient; active: boolean };
export class PostgresAdminDatabase {
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<Frame>();
  constructor(url: string) {
    this.pool = new Pool({connectionString: url, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 10000, idleTimeoutMillis: 30000, application_name: "orvyn-admin-reporting"});
    this.pool.on("error", () => console.warn("[admin-reporting] idle PostgreSQL connection failed"));
  }
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return operation();
    const client = await this.pool.connect();
    const frame = {client, active: true}; let discard: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path=pg_catalog,orvyn_auth");
      const result = await this.context.run(frame, operation);
      const commit = await client.query("COMMIT");
      if (commit.command !== "COMMIT") throw new Error("Reporting transaction did not complete");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = new Error("Reporting connection failed"); }
      throw error;
    } finally { frame.active = false; client.release(discard); }
  }
  private client(): PoolClient {
    const frame = this.context.getStore();
    if (!frame?.active) throw new Error("Reporting query outside active transaction");
    return frame.client;
  }
  private rows(result: QueryResult, session = false) {
    for (const row of result.rows) for (const field of result.fields) {
      const value = row[field.name]; if (value === null) continue;
      if (field.dataTypeID === 20) {
        const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("Reporting integer exceeds supported range");
        row[field.name] = n;
      } else if (session && field.dataTypeID === 25) row[field.name] = decodeSessionText(value);
    }
    return result.rows;
  }
  prepare(sql: string) {
    const query = async (values: unknown[]) => this.rows(await this.client().query(adminSql(sql), values));
    return {get: async (...values: unknown[]) => (await query(values))[0], all: async (...values: unknown[]) => query(values)};
  }
  async sessions<T>(tenantId: string, operation: (db: {prepare: PostgresAdminDatabase["prepare"]}) => Promise<T>, fallback: T): Promise<T> {
    const schema = sessionSchema(tenantId);
    const client = this.client();
    const exists = await client.query("SELECT to_regclass($1) AS relation", [schema + ".work_sessions"]);
    if (!exists.rows[0].relation) return fallback;
    return operation({prepare: (sql: string) => {
      const qualified = authSql(sql.replace(/\b(FROM|JOIN) (workspaces|work_sessions)\b/g, `$1 ${schema}.$2`));
      const query = async (values: unknown[]) => this.rows(await client.query(qualified, values), true);
      return {get: async (...values: unknown[]) => (await query(values))[0], all: async (...values: unknown[]) => query(values)};
    }});
  }
  close(): Promise<void> { return this.pool.end(); }
}
