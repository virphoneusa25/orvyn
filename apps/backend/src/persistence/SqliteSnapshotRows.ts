import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

const identifier = (name: string) => '"' + name.replace(/"/g, '""') + '"';

/** Complete text bytes on Node 22 too: native SQLite string reads can stop at NUL. */
export function readSqliteSnapshotRows(
  database: DatabaseSync, table: string, columns: readonly { name: string; type: string }[],
): Record<string, unknown>[] {
  const text = columns.filter(column => column.type.toUpperCase() === "TEXT").map(column => column.name);
  for (const column of text) {
    const invalid = database.prepare(`SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE typeof(${identifier(column)}) NOT IN ('text','null')`).get() as { n: number };
    if (invalid.n) throw new Error("Unsupported SQLite text value");
  }
  const select = columns.map(({ name }) => text.includes(name)
    ? `CASE WHEN ${identifier(name)} IS NULL THEN NULL ELSE hex(${identifier(name)}) END AS ${identifier(name)}`
    : identifier(name));
  const rows = database.prepare(`SELECT ${select.join(',')} FROM ${identifier(table)}`).all() as Record<string, unknown>[];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return rows.map(original => {
    const row = { ...original };
    for (const column of text) if (row[column] !== null) row[column] = decoder.decode(Buffer.from(String(row[column]), "hex"));
    return row;
  });
}
