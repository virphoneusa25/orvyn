import { readSqliteSnapshotRows } from "../persistence/SqliteSnapshotRows";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { STRIPE_TABLES, STRIPE_UNIQUE_KEYS } from "./stripeSchema";

export type StripeRow = Record<string, string | number | null>;
export type StripeSnapshot = Record<string, StripeRow[]>;

const canonicalKeys = (keys: readonly (readonly string[])[]) => JSON.stringify(Array.from(new Set(keys.map(key => JSON.stringify(key)))).sort());

/** Read-only, transaction-consistent export. Contains secrets; never log the snapshot. */
export function readStripeSnapshot(file: string): StripeSnapshot {
  const db = new DatabaseSync(file, { readOnly:true });
  try {
    db.exec("BEGIN");
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name:string; sql:string }[];
    if (JSON.stringify(tables.map(t => t.name)) !== JSON.stringify(STRIPE_TABLES.map(t => t.name))) throw new Error("Stripe payment table inventory differs from migration contract");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().length) throw new Error("Stripe payment trigger inventory differs from migration contract");
    const snapshot: StripeSnapshot = {};
    for (const table of STRIPE_TABLES) {
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all();
      if (columns.length !== table.columns.length || table.columns.some(column => !columns.some(actual =>
        actual.name === column.name && actual.type === column.type && Boolean(actual.notnull) === column.notNull && actual.pk === column.primaryKey))) {
        throw new Error(`Stripe payment schema differs: ${table.name}`);
      }
      const indexes = db.prepare(`PRAGMA index_list("${table.name}")`).all();
      const keys = indexes.filter(index => index.unique).map(index => db.prepare(
        `PRAGMA index_info("${String(index.name).replace(/"/g, '""')}")`).all().map(column => String(column.name)));
      keys.push(columns.filter(column => column.pk).sort((a,b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name)));
      if (canonicalKeys(keys) !== canonicalKeys(STRIPE_UNIQUE_KEYS[table.name])) throw new Error(`Stripe payment uniqueness differs: ${table.name}`);
      snapshot[table.name] = readSqliteSnapshotRows(db,table.name,table.columns) as StripeRow[];
    }
    validateStripeSnapshot(snapshot);
    db.exec("COMMIT");
    return snapshot;
  } finally { db.close(); }
}

export function validateStripeSnapshot(snapshot: StripeSnapshot): void {
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(STRIPE_TABLES.map(t => t.name).sort())) throw new Error("Incomplete Stripe payment snapshot");
  for (const table of STRIPE_TABLES) {
    for (const row of snapshot[table.name]) {
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(table.columns.map(c => c.name).sort())) throw new Error(`Stripe payment columns differ: ${table.name}`);
      for (const column of table.columns) {
        const value = row[column.name];
        if (value === null) {
          if (column.notNull || column.primaryKey) throw new Error(`Null Stripe payment key/required field: ${table.name}.${column.name}`);
        } else if (column.type === "INTEGER" ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== "string" || value.includes("\u0000")) {
          throw new Error(`Unsupported Stripe payment value: ${table.name}.${column.name}`);
        }
      }
    }
  }
}

/** Order independent, full-field fingerprint; suitable for private migration evidence. */
export function stripeSnapshotFingerprint(snapshot: StripeSnapshot): string {
  validateStripeSnapshot(snapshot);
  const canonical: [string,string[]][] = STRIPE_TABLES.map(table => [table.name, snapshot[table.name].map(row =>
    JSON.stringify(table.columns.map(column => row[column.name]))).sort()]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
