import { readSqliteSnapshotRows } from "../persistence/SqliteSnapshotRows";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { AUTH_TABLES, AUTH_UNIQUE_KEYS, AUTH_TRIGGERS } from "./authSchema";

export type AuthRow = Record<string, string | number | null>;
export type AuthSnapshot = Record<string, AuthRow[]>;

const canonicalKeys = (keys: readonly (readonly string[])[]) => JSON.stringify(Array.from(new Set(keys.map(key => JSON.stringify(key)))).sort());

/** Read-only, transaction-consistent export. Contains secrets; never log the snapshot. */
export function readAuthSnapshot(file: string): AuthSnapshot {
  const db = new DatabaseSync(file, { readOnly:true });
  try {
    db.exec("BEGIN");
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name:string; sql:string }[];
    if (JSON.stringify(tables.map(t => t.name)) !== JSON.stringify(AUTH_TABLES.map(t => t.name))) throw new Error("Authentication table inventory differs from migration contract");
    const snapshot: AuthSnapshot = {};
    for (const table of AUTH_TABLES) {
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all();
      if (columns.length !== table.columns.length || table.columns.some(column => !columns.some(actual =>
        actual.name === column.name && actual.type === column.type && Boolean(actual.notnull) === column.notNull && actual.pk === column.primaryKey))) {
        throw new Error(`Authentication schema differs: ${table.name}`);
      }
      const indexes = db.prepare(`PRAGMA index_list("${table.name}")`).all();
      const keys = indexes.filter(index => index.unique).map(index => db.prepare(
        `PRAGMA index_info("${String(index.name).replace(/"/g, '""')}")`).all().map(column => String(column.name)));
      keys.push(columns.filter(column => column.pk).sort((a,b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name)));
      if (canonicalKeys(keys) !== canonicalKeys(AUTH_UNIQUE_KEYS[table.name])) throw new Error(`Authentication uniqueness differs: ${table.name}`);
      snapshot[table.name] = readSqliteSnapshotRows(db,table.name,table.columns) as AuthRow[];
    }
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    const normalize = (value: unknown) => String(value).replace(/\s+/g, " ").trim();
    if (triggers.length !== AUTH_TRIGGERS.length || AUTH_TRIGGERS.some(trigger => !triggers.some(actual =>
      actual.name === trigger.name && normalize(actual.sql) === normalize(trigger.sql)))) throw new Error("Authentication audit protections differ");
    snapshot.__sequences = db.prepare("SELECT name,seq FROM sqlite_sequence").all() as AuthRow[];
    validateAuthSnapshot(snapshot);
    db.exec("COMMIT");
    return snapshot;
  } finally { db.close(); }
}

export function validateAuthSnapshot(snapshot: AuthSnapshot): void {
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["__sequences", ...AUTH_TABLES.map(t => t.name)].sort())) throw new Error("Incomplete authentication snapshot");
  const sequenceNames = new Set<string>();
  for (const row of snapshot.__sequences) {
    if (Object.keys(row).sort().join(",") !== "name,seq" || row.name !== "admin_audit" || sequenceNames.has(row.name) ||
      typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq >= Number.MAX_SAFE_INTEGER ||
      snapshot.admin_audit.some(audit => typeof audit.seq === "number" && audit.seq > Number(row.seq))) throw new Error("Unsupported authentication sequence");
    sequenceNames.add(row.name);
  }
  if (snapshot.admin_audit.length && !sequenceNames.has("admin_audit")) throw new Error("Missing authentication audit sequence");
  for (const table of AUTH_TABLES) {
    for (const row of snapshot[table.name]) {
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(table.columns.map(c => c.name).sort())) throw new Error(`Authentication columns differ: ${table.name}`);
      for (const column of table.columns) {
        const value = row[column.name];
        if (value === null) {
          if (column.notNull || column.primaryKey) throw new Error(`Null authentication key/required field: ${table.name}.${column.name}`);
        } else if (column.type === "INTEGER" ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== "string" || value.includes("\u0000")) {
          throw new Error(`Unsupported authentication value: ${table.name}.${column.name}`);
        }
      }
    }
  }
}

/** Order independent, full-field fingerprint; suitable for private migration evidence. */
export function authSnapshotFingerprint(snapshot: AuthSnapshot): string {
  validateAuthSnapshot(snapshot);
  const canonical: [string,string[]][] = AUTH_TABLES.map(table => [table.name, snapshot[table.name].map(row =>
    JSON.stringify(table.columns.map(column => row[column.name]))).sort()]);
  canonical.push(["__sequences", snapshot.__sequences.map(row => JSON.stringify([row.name,row.seq])).sort()]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
