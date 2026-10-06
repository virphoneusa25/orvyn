import test,{after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {spawnSync} from "node:child_process";
import {Pool} from "pg";
import {STRIPE_TABLES} from "./stripeSchema";
import {readStripeSnapshot,validateStripeSnapshot,stripeSnapshotFingerprint,type StripeSnapshot} from "./StripeStorageSnapshot";
import {PostgresStripeStorage} from "./PostgresStripeStorage";

const dir=mkdtempSync(join(tmpdir(),"stripe-migration-"));
const previous=process.env.ORVYN_DATA_DIR;process.env.ORVYN_DATA_DIR=dir;
const {StripeStore}=require("./stripe") as typeof import("./stripe");
(require("./creditLedgerInstance") as typeof import("./creditLedgerInstance")).creditLedger.close();
const file=join(dir,"payments.sqlite");
const store=new StripeStore(file);
store.saveCustomer("migration-account","cus_migration","private@example.invalid");
store.saveCheckout({sessionId:"cs_migration",accountId:"migration-account",kind:"subscription",item:"pro",period:"yearly"});
store.completeCheckout("cs_migration",{paymentIntent:"pi_migration",subscriptionId:"sub_migration"});
store.saveSubscription({subscriptionId:"sub_migration",accountId:"migration-account",planId:"pro",status:"active",periodStart:1700000000000,periodEnd:1702592000000,cancelAtPeriodEnd:true});
for(const status of ["processed","failed","ignored","received"] as const) {
  store.claimEvent("evt_"+status,"invoice.paid");
  if(status!=="received")store.finishEvent("evt_"+status,status,status==="failed" ? "Unicode Ω'quoted failure" : undefined);
}
store.db.close();
const source=readStripeSnapshot(file);
const empty:StripeSnapshot=Object.fromEntries(STRIPE_TABLES.map(t=>[t.name,[]]));
after(()=>{if(previous===undefined)delete process.env.ORVYN_DATA_DIR;else process.env.ORVYN_DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});});

test("Stripe snapshot preserves customer mappings, checkout links and all webhook states",()=>{
  assert.equal(STRIPE_TABLES.length,4);
  assert.ok(STRIPE_TABLES.every(t=>source[t.name].length));
  assert.equal(source.stripe_events.length,4);
  assert.equal(source.stripe_checkouts[0].payment_intent,"pi_migration");
  assert.equal(source.stripe_subscriptions[0].cancel_at_period_end,1);
  const reordered=Object.fromEntries(Object.entries(source).reverse().map(([k,v])=>[k,v.slice().reverse()]));
  assert.equal(stripeSnapshotFingerprint(reordered),stripeSnapshotFingerprint(source));
  const changed=structuredClone(source);changed.stripe_events[0].status="changed";
  assert.notEqual(stripeSnapshotFingerprint(changed),stripeSnapshotFingerprint(source));
});

test("Stripe preflight refuses missing fields, unsafe timestamps and unknown schemas without modifying source",()=>{
  for(const change of [
    (s:StripeSnapshot)=>{delete s.stripe_events;},
    (s:StripeSnapshot)=>{s.stripe_subscriptions[0].updated_at=Number.MAX_SAFE_INTEGER+1;},
    (s:StripeSnapshot)=>{s.stripe_customers[0].email="nul\u0000email";},
    (s:StripeSnapshot)=>{delete s.stripe_events[0].error;},
  ]) {const s=structuredClone(source);change(s);assert.throws(()=>validateStripeSnapshot(s));}
  const drift=join(dir,"drift.sqlite");const other=new StripeStore(drift);other.db.exec("CREATE TABLE future_payments(id TEXT)");other.db.close();
  assert.throws(()=>readStripeSnapshot(drift),/inventory/);
  const triggers=join(dir,"triggers.sqlite");const triggered=new StripeStore(triggers);
  triggered.db.exec("CREATE TRIGGER future_payment_rule BEFORE DELETE ON stripe_events BEGIN SELECT RAISE(ABORT,'future rule'); END");triggered.db.close();
  assert.throws(()=>readStripeSnapshot(triggers),/trigger inventory/);
  assert.equal(stripeSnapshotFingerprint(readStripeSnapshot(file)),stripeSnapshotFingerprint(source));
});

test("Stripe preflight prints counts only and requires no PostgreSQL connection",()=>{
  const result=spawnSync(process.execPath,[join(__dirname,"stripeMigrationCli.js"),"--source",file,"--check"],{
    encoding:"utf8",env:{...process.env,ORVYN_PAYMENTS_PG_URL:"postgres://invalid-host-do-not-contact"},timeout:10000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(Object.keys(JSON.parse(result.stdout).tables).length,4);
  assert.ok(!result.stdout.includes("private@example.invalid"));
  assert.ok(!result.stdout.includes("cus_migration"));
  assert.ok(!result.stdout.includes("quoted failure"));
});

test("real PostgreSQL Stripe import is atomic and concurrent and restores webhook replay protection",{
  skip:process.env.ORVYN_STRIPE_STORAGE_TEST!=="1"||!process.env.ORVYN_PG_URL,
},async()=>{
  const storage=new PostgresStripeStorage(process.env.ORVYN_PG_URL!),second=new PostgresStripeStorage(process.env.ORVYN_PG_URL!);
  const pool=new Pool({connectionString:process.env.ORVYN_PG_URL});
  try {
    await Promise.all([storage.init(),second.init()]);
    assert.equal((await storage.verify(empty)).matches,true);
    const duplicate=structuredClone(source);duplicate.stripe_customers.push({...duplicate.stripe_customers[0],account_id:"different-account"});
    await assert.rejects(storage.importSnapshot(duplicate),/unique constraint/);
    assert.equal((await storage.verify(empty)).matches,true);
    await pool.query(`CREATE FUNCTION orvyn_payments.fail_import_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced payment acknowledgement failure'; END; $$;
      CREATE TRIGGER fail_import_test BEFORE INSERT ON orvyn_payments.imports FOR EACH ROW EXECUTE FUNCTION orvyn_payments.fail_import_test()`);
    await assert.rejects(storage.importSnapshot(source),/forced payment acknowledgement failure/);
    assert.equal((await storage.verify(empty)).matches,true);
    await pool.query("DROP TRIGGER fail_import_test ON orvyn_payments.imports; DROP FUNCTION orvyn_payments.fail_import_test()");
    const results=await Promise.all([storage.importSnapshot(source),second.importSnapshot(source)]);
    assert.equal(results.filter(r=>r.imported).length,1);
    assert.equal((await storage.verify(source)).matches,true);
    const changed=structuredClone(source);changed.stripe_events[0].status="received";
    if(changed.stripe_events[0].status===source.stripe_events[0].status)changed.stripe_events[0].status="processed";
    await assert.rejects(storage.importSnapshot(changed),/refusing to overwrite/);
    const stored=await storage.exportSnapshot();
    const restored=new StripeStore(join(dir,"restored.sqlite"));
    try {
      restored.db.exec("BEGIN");
      for(const t of STRIPE_TABLES)for(const row of stored[t.name])restored.db.prepare(`INSERT INTO "${t.name}"(${t.columns.map(c=>c.name).join(",")}) VALUES (${t.columns.map(()=>"?").join(",")})`).run(...t.columns.map(c=>row[c.name]));
      restored.db.exec("COMMIT");
      assert.equal(stripeSnapshotFingerprint(readStripeSnapshot(join(dir,"restored.sqlite"))),stripeSnapshotFingerprint(source));
      assert.equal(restored.claimEvent("evt_processed","invoice.paid"),false);
      assert.equal(restored.claimEvent("evt_failed","invoice.paid"),true);
      assert.equal(restored.claimEvent("evt_ignored","invoice.paid"),true);
      assert.equal(restored.claimEvent("evt_received","invoice.paid"),true);
      assert.equal(restored.customerOf("migration-account"),"cus_migration");
      assert.equal(restored.accountOfCustomer("cus_migration"),"migration-account");
      assert.equal(restored.checkoutByPaymentIntent("pi_migration")!.account_id,"migration-account");
      assert.equal(restored.periodOf("sub_migration"),"yearly");
      assert.equal(restored.latestSubscription("migration-account")!.cancel_at_period_end,1);
    }finally{restored.db.close();}
    await pool.query("CREATE TABLE orvyn_payments.future_payments(id TEXT)");
    try{await assert.rejects(storage.exportSnapshot(),/inventory differs/);}finally{await pool.query("DROP TABLE orvyn_payments.future_payments");}
  }finally{await pool.end();await storage.close();await second.close();}
});
