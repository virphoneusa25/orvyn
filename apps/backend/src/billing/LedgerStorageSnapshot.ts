import { LEGACY_LEDGER_TABLES } from "./legacyLedgerSchema";
import { readSqliteSnapshotRows } from "../persistence/SqliteSnapshotRows";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { LEDGER_TABLES, LEDGER_UNIQUE_KEYS, LEDGER_TRIGGERS } from "./ledgerSchema";

export type LedgerRow = Record<string, string | number | null>;
export type LedgerSnapshot = Record<string, LedgerRow[]>;
function validateLegacyRows(table: typeof LEGACY_LEDGER_TABLES[number], rows: LedgerRow[]): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(table.columns.map(c => c.name).sort()) ||
      table.columns.some(column => column.type === "TEXT"
        ? typeof row[column.name] !== "string" || String(row[column.name]).includes("\u0000")
        : typeof row[column.name] !== "number" || !(column.type === "INTEGER" ? Number.isSafeInteger(row[column.name]) : Number.isFinite(row[column.name]))) || ids.has(String(row[table.key]))) {
      throw new Error("Unsupported archived v1 ledger record");
    }
    ids.add(String(row[table.key]));
  }
}

const canonicalKeys = (keys: readonly (readonly string[])[]) => JSON.stringify(Array.from(new Set(keys.map(key => JSON.stringify(key)))).sort());

/** Read-only, transaction-consistent export. Contains secrets; never log the snapshot. */
export function readLedgerSnapshot(file: string): LedgerSnapshot {
  const db = new DatabaseSync(file, { readOnly:true });
  try {
    db.exec("BEGIN");
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name:string; sql:string }[];
    if (JSON.stringify(tables.filter(t => !LEGACY_LEDGER_TABLES.some(legacy => legacy.name === t.name)).map(t => t.name)) !== JSON.stringify(LEDGER_TABLES.map(t => t.name))) throw new Error("Credit ledger table inventory differs from migration contract");
    const snapshot: LedgerSnapshot = {};
    for (const legacy of LEGACY_LEDGER_TABLES.filter(legacy => tables.some(table => table.name === legacy.name))) {
      const columns = db.prepare(`PRAGMA table_info("${legacy.name}")`).all();
      if (columns.length !== legacy.columns.length || legacy.columns.some(column => !columns.some(actual =>
        actual.name === column.name && actual.type === column.type && actual.pk === (column.name === legacy.key ? 1 : 0) &&
        Boolean(actual.notnull) === (column.name !== legacy.key)))) throw new Error("Archived v1 ledger schema differs");
      const archived = db.prepare(`SELECT * FROM "${legacy.name}"`).all() as LedgerRow[];
      validateLegacyRows(legacy, archived);
      if (legacy.name === "v1_accounts" && archived.some(row => !db.prepare("SELECT 1 FROM wallets WHERE account_id=?").get(row.user_id))) throw new Error("Archived v1 ledger account has no migrated wallet");
      if (archived.length) snapshot[`__legacy_${legacy.name}`] = archived;
    }
    for (const table of LEDGER_TABLES) {
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all();
      if (columns.length !== table.columns.length || table.columns.some(column => !columns.some(actual =>
        actual.name === column.name && actual.type === column.type && Boolean(actual.notnull) === column.notNull && actual.pk === column.primaryKey))) {
        throw new Error(`Credit ledger schema differs: ${table.name}`);
      }
      const indexes = db.prepare(`PRAGMA index_list("${table.name}")`).all();
      const keys = indexes.filter(index => index.unique).map(index => db.prepare(
        `PRAGMA index_info("${String(index.name).replace(/"/g, '""')}")`).all().map(column => String(column.name)));
      keys.push(columns.filter(column => column.pk).sort((a,b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name)));
      if (canonicalKeys(keys) !== canonicalKeys(LEDGER_UNIQUE_KEYS[table.name])) throw new Error(`Credit ledger uniqueness differs: ${table.name}`);
      snapshot[table.name] = readSqliteSnapshotRows(db,table.name,table.columns) as LedgerRow[];
    }
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    const normalize = (value: unknown) => String(value).replace(/\s+/g, " ").trim();
    if (triggers.length !== LEDGER_TRIGGERS.length || LEDGER_TRIGGERS.some(trigger => !triggers.some(actual =>
      actual.name === trigger.name && normalize(actual.sql) === normalize(trigger.sql)))) throw new Error("Credit ledger audit protections differ");
    const ledgerSql = tables.find(table => table.name === "ledger_entries")!.sql;
    if (!/CHECK\s*\(\s*bucket\s+IN\s*\(\s*'included'\s*,\s*'purchased'\s*,\s*'hold'\s*\)\s*\)/i.test(ledgerSql)) throw new Error("Credit ledger bucket protection differs");
    snapshot.__sequences = db.prepare("SELECT name,seq FROM sqlite_sequence").all() as LedgerRow[];
    validateLedgerSnapshot(snapshot);
    db.exec("COMMIT");
    return snapshot;
  } finally { db.close(); }
}

export function validateLedgerSnapshot(snapshot: LedgerSnapshot): void {
  const legacyKeys = LEGACY_LEDGER_TABLES.map(t => `__legacy_${t.name}`).filter(key => snapshot[key]);
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["__sequences", ...legacyKeys, ...LEDGER_TABLES.map(t => t.name)].sort())) throw new Error("Incomplete ledger snapshot");
  for (const legacy of LEGACY_LEDGER_TABLES) {
    const archived = snapshot[`__legacy_${legacy.name}`];
    if (!archived) continue;
    validateLegacyRows(legacy, archived);
    if (!archived.length || legacy.name === "v1_accounts" && archived.some(row => !snapshot.wallets.some(wallet => wallet.account_id === row.user_id))) throw new Error("Archived v1 ledger account has no migrated wallet");
  }
  const sequenceNames = new Set<string>();
  for (const row of snapshot.__sequences) {
    if (Object.keys(row).sort().join(",") !== "name,seq" || row.name !== "ledger_entries" || sequenceNames.has(row.name) ||
      typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq >= Number.MAX_SAFE_INTEGER ||
      snapshot.ledger_entries.some(audit => typeof audit.seq === "number" && audit.seq > Number(row.seq))) throw new Error("Unsupported ledger sequence");
    sequenceNames.add(row.name);
  }
  if (snapshot.ledger_entries.length && !sequenceNames.has("ledger_entries")) throw new Error("Missing ledger audit sequence");
  if (snapshot.ledger_entries.some(row => !["included","purchased","hold"].includes(String(row.bucket)))) throw new Error("Unsupported ledger bucket");
  for (const table of LEDGER_TABLES) {
    for (const row of snapshot[table.name]) {
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(table.columns.map(c => c.name).sort())) throw new Error(`Credit ledger columns differ: ${table.name}`);
      for (const column of table.columns) {
        const value = row[column.name];
        if (value === null) {
          if (column.notNull || column.primaryKey) throw new Error(`Null ledger key/required field: ${table.name}.${column.name}`);
        } else if (column.type === "INTEGER" ? typeof value !== "number" || !Number.isSafeInteger(value) : column.type === "REAL" ? typeof value !== "number" || !Number.isFinite(value) : typeof value !== "string" || value.includes("\u0000")) {
          throw new Error(`Unsupported ledger value: ${table.name}.${column.name}`);
        }
      }
    }
  }
}

/** Order independent, full-field fingerprint; suitable for private migration evidence. */
export function ledgerSnapshotFingerprint(snapshot: LedgerSnapshot): string {
  validateLedgerSnapshot(snapshot);
  const canonical: [string,string[]][] = LEDGER_TABLES.map(table => [table.name, snapshot[table.name].map(row =>
    JSON.stringify(table.columns.map(column => row[column.name]))).sort()]);
  canonical.push(["__sequences", snapshot.__sequences.map(row => JSON.stringify([row.name,row.seq])).sort()]);
  for (const legacy of LEGACY_LEDGER_TABLES) {
    const key = `__legacy_${legacy.name}`;
    if (snapshot[key]) canonical.push([key, snapshot[key].map(row => JSON.stringify(legacy.columns.map(c => row[c.name]))).sort()]);
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
