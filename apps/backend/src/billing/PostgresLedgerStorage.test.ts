import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { CreditLedger } from "./CreditLedger";
import { LEDGER_TABLES } from "./ledgerSchema";
import { readLedgerSnapshot, validateLedgerSnapshot, ledgerSnapshotFingerprint, type LedgerSnapshot } from "./LedgerStorageSnapshot";
import { PostgresLedgerStorage } from "./PostgresLedgerStorage";

const dir=mkdtempSync(join(tmpdir(),"ledger-migration-"));
const file=join(dir,"billing.sqlite");
const ledger=new CreditLedger(file);
const now=1700000000000;
ledger.ensureAccount("migration-account",undefined,now);
ledger.adminAdjust("migration-account",1234,{actor:"test",reason:"Unicode Ω'quoted",key:"migration-adjustment"},now);
ledger.reserve("migration-account","migration-run",100,now);
ledger.close();
const db=new DatabaseSync(file);
for(const table of LEDGER_TABLES) {
  if(Number(db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get()!.n)) continue;
  const values=table.columns.map((c,i)=>!c.notNull&&!c.primaryKey&&i%2===0 ? null :
    c.type==="INTEGER" ? 100+i : c.type==="REAL" ? 0.0123456789+i : `${table.name}:${c.name}:Ω'quoted`);
  db.prepare(`INSERT INTO "${table.name}"(${table.columns.map(c=>`"${c.name}"`).join(",")}) VALUES (${values.map(()=>"?").join(",")})`).run(...values);
}
db.exec("UPDATE sqlite_sequence SET seq=seq+100 WHERE name='ledger_entries'");
db.close();
const source=readLedgerSnapshot(file);
const empty:LedgerSnapshot={...Object.fromEntries(LEDGER_TABLES.map(t=>[t.name,[]])),__sequences:[]};
after(()=>rmSync(dir,{recursive:true,force:true}));

test("ledger snapshot preserves every active table, fractional prices, reservations and sequence gaps",()=>{
  assert.equal(LEDGER_TABLES.length,10);
  assert.ok(LEDGER_TABLES.every(t=>source[t.name].length));
  assert.equal(source.image_rate_cards[0].usd_per_image,3.0123456789);
  assert.ok(Number(source.__sequences[0].seq)>Math.max(...source.ledger_entries.map(r=>Number(r.seq))));
  const reordered=Object.fromEntries(Object.entries(source).reverse().map(([k,v])=>[k,v.slice().reverse()]));
  assert.equal(ledgerSnapshotFingerprint(source),ledgerSnapshotFingerprint(reordered));
  const changed=structuredClone(source);changed.image_rate_cards[0].usd_per_image=0.5;
  assert.notEqual(ledgerSnapshotFingerprint(source),ledgerSnapshotFingerprint(changed));
});

test("ledger preflight rejects missing data, unsafe amounts, nonfinite prices, invalid buckets and future schema",()=>{
  for(const change of [
    (s:LedgerSnapshot)=>{delete s.wallets;},
    (s:LedgerSnapshot)=>{s.ledger_entries[0].amount=Number.MAX_SAFE_INTEGER+1;},
    (s:LedgerSnapshot)=>{s.rate_cards[0].input_usd_per_million=Infinity;},
    (s:LedgerSnapshot)=>{s.ledger_entries[0].bucket="invalid";},
    (s:LedgerSnapshot)=>{s.wallets[0].account_id="nul\u0000account";},
    (s:LedgerSnapshot)=>{s.__sequences[0].seq=0;},
  ]) {const invalid=structuredClone(source);change(invalid);assert.throws(()=>validateLedgerSnapshot(invalid));}
  const drift=join(dir,"drift.sqlite");new CreditLedger(drift).close();
  const other=new DatabaseSync(drift);other.exec("CREATE TABLE future_financial_records(id TEXT)");other.close();
  assert.throws(()=>readLedgerSnapshot(drift),/inventory/);
  assert.equal(ledgerSnapshotFingerprint(readLedgerSnapshot(file)),ledgerSnapshotFingerprint(source));
});

test("ledger preflight requires immutable entries and performs no connection or data disclosure",()=>{
  const result=spawnSync(process.execPath,[join(__dirname,"ledgerMigrationCli.js"),"--source",file,"--check"],{
    encoding:"utf8",env:{...process.env,ORVYN_BILLING_PG_URL:"postgres://invalid-host-do-not-contact"},timeout:10000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(Object.keys(JSON.parse(result.stdout).tables).length,10);
  assert.ok(!result.stdout.includes("migration-account"));
  assert.ok(!result.stdout.includes("quoted"));
  const drift=join(dir,"unprotected.sqlite");new CreditLedger(drift).close();
  const other=new DatabaseSync(drift);other.exec("DROP TRIGGER ledger_no_delete");other.close();
  assert.throws(()=>readLedgerSnapshot(drift),/protections/);
});

test("real PostgreSQL ledger import rolls back late failures, serializes imports and restores exact balances",{
  skip:process.env.ORVYN_LEDGER_STORAGE_TEST!=="1"||!process.env.ORVYN_PG_URL,
},async()=>{
  const storage=new PostgresLedgerStorage(process.env.ORVYN_PG_URL!);
  const second=new PostgresLedgerStorage(process.env.ORVYN_PG_URL!);
  const pool=new Pool({connectionString:process.env.ORVYN_PG_URL});
  try {
    await Promise.all([storage.init(),second.init()]);
    assert.equal((await storage.verify(empty)).matches,true);
    const duplicate=structuredClone(source);duplicate.ledger_entries.push({...duplicate.ledger_entries[0],seq:50,id:"different-id"});
    await assert.rejects(storage.importSnapshot(duplicate),/unique constraint/);
    assert.equal((await storage.verify(empty)).matches,true);
    await pool.query(`CREATE FUNCTION orvyn_billing.fail_import_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced ledger acknowledgement failure'; END; $$;
      CREATE TRIGGER fail_import_test BEFORE INSERT ON orvyn_billing.imports FOR EACH ROW EXECUTE FUNCTION orvyn_billing.fail_import_test()`);
    await assert.rejects(storage.importSnapshot(source),/forced ledger acknowledgement failure/);
    assert.equal((await storage.verify(empty)).matches,true,"late rejection rolls back rows and identity counter");
    await pool.query("DROP TRIGGER fail_import_test ON orvyn_billing.imports; DROP FUNCTION orvyn_billing.fail_import_test()");
    const imports=await Promise.all([storage.importSnapshot(source),second.importSnapshot(source)]);
    assert.equal(imports.filter(r=>r.imported).length,1);
    assert.equal((await storage.verify(source)).matches,true);
    const changed=structuredClone(source);changed.wallets[0].plan_id="different";
    await assert.rejects(storage.importSnapshot(changed),/refusing to overwrite/);
    const stored=await storage.exportSnapshot();
    const restore=join(dir,"restored.sqlite");new CreditLedger(restore).close();
    const restoredDb=new DatabaseSync(restore);
    try {
      // New CreditLedger seeded its default price, but no entries exist yet.
      restoredDb.exec("DELETE FROM rate_cards; BEGIN");
      for(const table of LEDGER_TABLES) for(const row of stored[table.name]) restoredDb.prepare(
        `INSERT INTO "${table.name}"(${table.columns.map(c=>`"${c.name}"`).join(",")}) VALUES (${table.columns.map(()=>"?").join(",")})`,
      ).run(...table.columns.map(c=>row[c.name]));
      restoredDb.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='ledger_entries'").run(Number(stored.__sequences[0].seq));
      restoredDb.exec("COMMIT");
    } finally {restoredDb.close();}
    assert.equal(ledgerSnapshotFingerprint(readLedgerSnapshot(restore)),ledgerSnapshotFingerprint(source));
    const originalLedger=new CreditLedger(file),restoredLedger=new CreditLedger(restore);
    try {assert.deepEqual(restoredLedger.accounts(),originalLedger.accounts());assert.deepEqual(restoredLedger.entries("migration-account"),originalLedger.entries("migration-account"));}
    finally {originalLedger.close();restoredLedger.close();}
    const expected=source.ledger_entries.reduce((n,r)=>n+Number(r.amount),0);
    assert.equal(Number((await pool.query("SELECT sum(amount) AS n FROM orvyn_billing.ledger_entries")).rows[0].n),expected);
    for(const sql of ["UPDATE orvyn_billing.ledger_entries SET amount=0","DELETE FROM orvyn_billing.ledger_entries","TRUNCATE orvyn_billing.ledger_entries"])
      await assert.rejects(pool.query(sql),/append-only/);
    const columns=LEDGER_TABLES.find(t=>t.name==="ledger_entries")!.columns.filter(c=>c.name!=="seq");
    const row:Record<string,string|number|null>={...source.ledger_entries[0],id:"new-entry",idempotency_key:"new-key"};
    const inserted=await pool.query(`INSERT INTO orvyn_billing.ledger_entries(${columns.map(c=>c.name).join(",")}) VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")}) RETURNING seq`,columns.map(c=>row[c.name]));
    assert.equal(Number(inserted.rows[0].seq),Number(source.__sequences[0].seq)+1);
    await assert.rejects(pool.query(`INSERT INTO orvyn_billing.ledger_entries(${columns.map(c=>c.name).join(",")}) VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")})`,columns.map(c=>c.name==="id" ? "duplicate-key-entry" : row[c.name])),/unique constraint/);
    await pool.query("CREATE TABLE orvyn_billing.future_financial_records(id TEXT)");
    try {await assert.rejects(storage.exportSnapshot(),/inventory differs/);}
    finally {await pool.query("DROP TABLE orvyn_billing.future_financial_records");}
    await pool.query("ALTER TABLE orvyn_billing.ledger_entries DISABLE TRIGGER ledger_entries_no_truncate");
    try {await assert.rejects(storage.exportSnapshot(),/protections differ/);}
    finally {await pool.query("ALTER TABLE orvyn_billing.ledger_entries ENABLE TRIGGER ledger_entries_no_truncate");}
  } finally {await pool.end();await storage.close();await second.close();}
});
