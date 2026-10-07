import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readSqliteSnapshotRows } from "./SqliteSnapshotRows";

test("SQLite snapshot reads preserve NUL suffixes, nulls and quoted identifiers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec('CREATE TABLE "quoted" ("a" TEXT, "b" INTEGER, "c" TEXT)');
    const value = "prefix\0suffix\\0🌲";
    database.prepare('INSERT INTO quoted VALUES(?,?,?)').run(value, 123, null);
    assert.deepEqual(readSqliteSnapshotRows(database, "quoted", [{ name: "a", type: "TEXT" }, { name: "b", type: "INTEGER" }, { name: "c", type: "TEXT" }]), [{ a: value, b: 123, c: null }]);
    assert.equal(database.prepare('SELECT hex(a) AS bytes FROM quoted').get()?.bytes, Buffer.from(value).toString("hex").toUpperCase());
  } finally { database.close(); }
});

test("SQLite snapshot refuses binary and malformed UTF-8 in text columns", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES(X'FF')");
    assert.throws(() => readSqliteSnapshotRows(database, "fixture", [{ name: "value", type: "TEXT" }]), /Unsupported/);
    database.exec("UPDATE fixture SET value=CAST(X'FF' AS TEXT)");
    assert.throws(() => readSqliteSnapshotRows(database, "fixture", [{ name: "value", type: "TEXT" }]));
  } finally { database.close(); }
});
