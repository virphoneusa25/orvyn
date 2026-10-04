import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { AUTH_TABLES } from "./authSchema";
import { authSnapshotFingerprint, readAuthSnapshot, validateAuthSnapshot, type AuthSnapshot } from "./AuthStorageSnapshot";
import { PostgresAuthStorage } from "./PostgresAuthStorage";

const dir = mkdtempSync(join(tmpdir(), "auth-storage-"));
const previousDir = process.env.ORVYN_DATA_DIR;
process.env.ORVYN_DATA_DIR = dir;
// Load only after isolating the eager authentication singleton from normal data.
const { AuthService, authService } = require("../auth/AuthService") as typeof import("../auth/AuthService");
authService.close();
const auth = new AuthService(dir);
const account = auth.register("migration@example.invalid", "migration-password", "Migration Unicode Ω");
const principal = auth.verifyPrincipal(account.token)!.principal;
const key = auth.createApiKey(principal, "Kept key");
const revoked = auth.createApiKey(principal, "Revoked key");
auth.revokeApiKey(account.user.id, revoked.record.id);
const verification = auth.createEmailVerification(account.user.id);
const reset = auth.createPasswordReset(account.user.email)!;
auth.saveOAuthState({ state:"migration-state", provider:"github", verifier:"private-verifier", client:"desktop" });
auth.close();

// Exercise every table and column, including nullable metadata, without logging records.
const db = new DatabaseSync(join(dir, "auth.db"));
for (const table of AUTH_TABLES) {
  if (Number((db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get() as { n:number }).n)) continue;
  const values = table.columns.map((column, index) => !column.notNull && !column.primaryKey && index % 2 === 0 ? null :
    column.type === "INTEGER" ? 1700000000000 + index : `${table.name}:${column.name}:Ω'quoted`);
  db.prepare(`INSERT INTO "${table.name}"(${table.columns.map(c => `"${c.name}"`).join(",")}) VALUES (${values.map(() => "?").join(",")})`).run(...values);
}
db.close();
const source = readAuthSnapshot(join(dir, "auth.db"));
const empty: AuthSnapshot = Object.fromEntries(AUTH_TABLES.map(table => [table.name, []]));
const integration = process.env.ORVYN_AUTH_STORAGE_TEST === "1" && Boolean(process.env.ORVYN_PG_URL);

after(() => {
  if (previousDir === undefined) delete process.env.ORVYN_DATA_DIR; else process.env.ORVYN_DATA_DIR = previousDir;
  rmSync(dir, { recursive:true, force:true });
});

test("authentication snapshot covers the complete production schema and all fields", () => {
  assert.equal(AUTH_TABLES.length, 18);
  assert.ok(AUTH_TABLES.every(table => source[table.name].length > 0));
  assert.match(String(source.users[0].password_hash), /^scrypt:/);
  assert.ok(!JSON.stringify(source).includes(account.token));
  assert.ok(!JSON.stringify(source).includes(key.key));
  const reordered = Object.fromEntries(Object.entries(source).reverse().map(([table, rows]) => [table, rows.slice().reverse()]));
  assert.equal(authSnapshotFingerprint(reordered), authSnapshotFingerprint(source));
  const changed = JSON.parse(JSON.stringify(source));
  changed.users[0].name += "changed";
  assert.notEqual(authSnapshotFingerprint(changed), authSnapshotFingerprint(source));
});

test("authentication export rejects unknown schema and invalid values without changing source", () => {
  const invalid = JSON.parse(JSON.stringify(source));
  invalid.users[0].name = "unsupported\u0000name";
  assert.throws(() => validateAuthSnapshot(invalid), /users.name/);
  invalid.users[0].name = "valid";
  invalid.users[0].created_at = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateAuthSnapshot(invalid), /users.created_at/);
  const missing = { ...source }; delete missing.api_keys;
  assert.throws(() => validateAuthSnapshot(missing), /Incomplete/);
  const drift = new AuthService(join(dir, "drift")); drift.close();
  // Use its own file so the main source remains unchanged.
  const other = new DatabaseSync(join(dir, "drift", "auth.db"));
  other.exec("ALTER TABLE users ADD COLUMN future_column TEXT"); other.close();
  assert.throws(() => readAuthSnapshot(join(dir, "drift", "auth.db")), /schema differs/);
  assert.equal(authSnapshotFingerprint(readAuthSnapshot(join(dir, "auth.db"))), authSnapshotFingerprint(source));
});

test("authentication preflight prints counts only and does not connect to PostgreSQL", () => {
  const result = spawnSync(process.execPath, [join(__dirname, "authMigrationCli.js"), "--source", join(dir, "auth.db"), "--check"], {
    encoding:"utf8", env:{ ...process.env, ORVYN_AUTH_PG_URL:"postgres://invalid-host-do-not-contact" }, timeout:10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ready, true);
  assert.equal(Object.keys(output.tables).length, 18);
  assert.ok(!result.stdout.includes(account.user.email));
  assert.ok(!result.stdout.includes("scrypt:"));
  assert.ok(!result.stdout.includes("private-verifier"));
});

test("historical column order does not change the authentication contract", () => {
  const historicalDir = join(dir, "historical");
  const setup = new AuthService(historicalDir); setup.close();
  const historical = new DatabaseSync(join(historicalDir, "auth.db"));
  try {
    const table = AUTH_TABLES.find(table => table.name === "users")!;
    historical.exec("DROP TABLE users");
    historical.exec(`CREATE TABLE users (${table.columns.slice().reverse().map(column =>
      `"${column.name}" ${column.type}${column.notNull ? " NOT NULL" : ""}`).join(",")}, PRIMARY KEY(id), UNIQUE(email))`);
  } finally { historical.close(); }
  assert.doesNotThrow(() => readAuthSnapshot(join(historicalDir, "auth.db")));
});

test("real Postgres: complete auth import is atomic, concurrent, exact and restores account behavior", { skip:!integration }, async () => {
  const storage = new PostgresAuthStorage(process.env.ORVYN_PG_URL!);
  const second = new PostgresAuthStorage(process.env.ORVYN_PG_URL!);
  try {
    await Promise.all([storage.init(), second.init()]);
    assert.equal((await storage.verify(empty)).matches, true);
    const duplicate = JSON.parse(JSON.stringify(source));
    duplicate.users.push({ ...duplicate.users[0], id:"different-user-same-email" });
    await assert.rejects(storage.importSnapshot(duplicate), /unique constraint/);
    assert.equal((await storage.verify(empty)).matches, true, "failed import must leave every table empty");
    const imported = await Promise.all([storage.importSnapshot(source), second.importSnapshot(source)]);
    assert.equal(imported.filter(result => result.imported).length, 1);
    const verified = await storage.verify(source);
    assert.equal(verified.matches, true);
    assert.ok(Object.values(verified.counts).every(count => count > 0));
    const changed = JSON.parse(JSON.stringify(source)); changed.users[0].name = "Changed";
    await assert.rejects(storage.importSnapshot(changed), /refusing to overwrite/);
    assert.equal((await storage.verify(source)).matches, true);
    const exported = await storage.exportSnapshot();
    assert.equal(authSnapshotFingerprint(exported), authSnapshotFingerprint(source));

    const recoveredDir = join(dir, "recovered");
    const setup = new AuthService(recoveredDir); setup.close();
    const recoveredDb = new DatabaseSync(join(recoveredDir, "auth.db"));
    try {
      recoveredDb.exec("BEGIN");
      for (const table of AUTH_TABLES) for (const row of exported[table.name]) {
        recoveredDb.prepare(`INSERT INTO "${table.name}"(${table.columns.map(c => `"${c.name}"`).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`).run(...table.columns.map(c => row[c.name]));
      }
      recoveredDb.exec("COMMIT");
    } finally { recoveredDb.close(); }
    const recovered = new AuthService(recoveredDir);
    try {
      assert.equal(recovered.verifyPrincipal(account.token)!.principal.tenantId, principal.tenantId);
      assert.equal(recovered.login(account.user.email, "migration-password").user.id, account.user.id);
      assert.equal(recovered.verifyApiKey(key.key)!.user.id, account.user.id);
      assert.equal(recovered.verifyApiKey(revoked.key), null);
      assert.equal(recovered.verifyEmailToken(verification.token)!.id, account.user.id);
      assert.equal(recovered.verifyEmailToken(verification.token), null);
      assert.equal(recovered.takeOAuthState("migration-state", "github")!.verifier, "private-verifier");
      assert.equal(recovered.takeOAuthState("migration-state", "github"), null);
      assert.equal(recovered.resetPassword(reset.token, "changed-password").id, account.user.id);
      assert.equal(recovered.verify(account.token), null);
      assert.throws(() => recovered.resetPassword(reset.token, "another-password"), /expired/);
      assert.equal(recovered.login(account.user.email, "changed-password").user.id, account.user.id);
    } finally { recovered.close(); }
    const audit = new Pool({ connectionString:process.env.ORVYN_PG_URL });
    try {
      await audit.query("UPDATE orvyn_auth.api_keys SET revoked_at=NULL WHERE id=$1", [revoked.record.id]);
      assert.equal((await storage.verify(source)).matches, false, "same counts must not conceal changed revocation metadata");
      await audit.query("UPDATE orvyn_auth.api_keys SET revoked_at=$1 WHERE id=$2", [source.api_keys.find(row => row.id === revoked.record.id)!.revoked_at, revoked.record.id]);
      await audit.query("ALTER TABLE orvyn_auth.users ADD COLUMN unexpected TEXT");
      await assert.rejects(storage.verify(source), /schema differs/);
      await audit.query("ALTER TABLE orvyn_auth.users DROP COLUMN unexpected");
      assert.equal((await storage.verify(source)).matches, true);
    } finally { await audit.end(); }
  } finally { await storage.close(); await second.close(); }
});
