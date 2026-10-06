import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { PostgresAuthStorage } from "../identity/PostgresAuthStorage";

/** Login rejection commits its persistent failure counter, while other failures roll back. */
export class LoginRejected extends Error {}

export function authSql(sql: string): string {
  if (/INSERT OR REPLACE/i.test(sql)) {
    const match = sql.match(/^\s*INSERT OR REPLACE INTO (organization_members|session_rotations)\s*\(([^)]+)\)/i);
    if (!match) throw new Error("Unsupported authentication replacement statement");
    const columns = match[2].split(",").map(value => value.trim());
    const keys = match[1] === "organization_members" ? ["organization_id", "user_id"] : ["old_hash"];
    sql = sql.replace(/INSERT OR REPLACE/i, "INSERT") + ` ON CONFLICT (${keys.join(",")}) DO UPDATE SET ` +
      columns.filter(column => !keys.includes(column)).map(column => `${column}=excluded.${column}`).join(",");
  } else if (/INSERT OR IGNORE/i.test(sql)) {
    sql = sql.replace(/INSERT OR IGNORE/i, "INSERT") + " ON CONFLICT DO NOTHING";
  }
  sql = sql.replace(/SET count = count \+ 1/g, "SET count = login_failures.count + 1");
  let quoted = false;
  let index = 0;
  let translated = "";
  for (let offset = 0; offset < sql.length; offset++) {
    const character = sql[offset];
    if (character === "'") {
      if (quoted && sql[offset + 1] === "'") { translated += "''"; offset++; continue; }
      quoted = !quoted;
    }
    translated += character === "?" && !quoted ? `$${++index}` : character;
  }
  return translated;
}

/** Async SQL boundary for the shared authentication behavior. No SQLite fallback. */
export class PostgresAuthDatabase {
  private context = new AsyncLocalStorage<PoolClient>();
  private pool: Pool;
  private constructor(url:string) {
    this.pool = new Pool({ connectionString:url, max:4, connectionTimeoutMillis:5000,
      statement_timeout:10000, lock_timeout:5000, idleTimeoutMillis:30000 });
  }

  static async connect(url:string): Promise<PostgresAuthDatabase> {
    const storage = new PostgresAuthStorage(url);
    try { await storage.init(); await storage.exportSnapshot(); } finally { await storage.close(); }
    return new PostgresAuthDatabase(url);
  }

  async transaction<T>(operation:() => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const client = await this.pool.connect();
    let discard: Error | undefined;
    let finished = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(730021,2)");
      await client.query("SET LOCAL search_path=pg_catalog,orvyn_auth");
      try {
        const result = await this.context.run(client, operation);
        await client.query("COMMIT");
        finished = true;
        return result;
      } catch (error) {
        if (error instanceof LoginRejected) { await client.query("COMMIT"); finished = true; throw error; }
        throw error;
      }
    } catch (error) {
      if (!finished) try { await client.query("ROLLBACK"); } catch { discard = new Error("Authentication transaction connection failed"); }
      throw error;
    } finally { client.release(discard); }
  }

  prepare(sql:string) {
    const query = async (values:unknown[]) => {
      const client = this.context.getStore();
      if (!client) throw new Error("Authentication query outside transaction");
      const result = await client.query(authSql(sql), values);
      for (const row of result.rows) for (const field of result.fields) {
        if (field.dataTypeID !== 20 || row[field.name] === null) continue;
        const number = Number(row[field.name]);
        if (!Number.isSafeInteger(number)) throw new Error("Authentication integer exceeds supported range");
        row[field.name] = number;
      }
      return result;
    };
    return {
      get:async (...values:unknown[]) => (await query(values)).rows[0],
      all:async (...values:unknown[]) => (await query(values)).rows,
      run:async (...values:unknown[]) => ({ changes:(await query(values)).rowCount ?? 0 }),
    };
  }

  async close():Promise<void> { await this.pool.end(); }
}
