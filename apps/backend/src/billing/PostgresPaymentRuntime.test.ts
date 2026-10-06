import test from "node:test";
import assert from "node:assert/strict";
import {Pool} from "pg";
import {PostgresBillingDatabase,paymentSql} from "./PostgresBillingDatabase";
import {PostgresStripeStore} from "./PostgresStripeStore";

const integration=process.env.ORVYN_PAYMENT_RUNTIME_TEST==="1"&&Boolean(process.env.ORVYN_PG_URL);
test("payment SQL preserves quoted question marks and qualifies existing subscription periods",()=>{
  assert.equal(paymentSql("SELECT '?', 'it''s ?' WHERE id=? AND status=?"),"SELECT '?', 'it''s ?' WHERE id=$1 AND status=$2");
  assert.equal(paymentSql("INSERT OR IGNORE INTO stripe_events(id) VALUES (?)"),"INSERT INTO stripe_events(id) VALUES ($1) ON CONFLICT DO NOTHING");
  assert.match(paymentSql("COALESCE(excluded.period_start, period_start)"),/stripe_subscriptions.period_start/);
  assert.throws(()=>paymentSql("INSERT OR REPLACE INTO stripe_events(id) VALUES (?)"),/Unsupported/);
});

test("real PostgreSQL payment runtime preserves mappings, subscriptions, retries and cross-instance reads",{skip:!integration},async()=>{
  const db=await PostgresBillingDatabase.connect(process.env.ORVYN_PG_URL!);
  const other=await PostgresBillingDatabase.connect(process.env.ORVYN_PG_URL!);
  const store=PostgresStripeStore.fromDatabase(db),second=PostgresStripeStore.fromDatabase(other);
  try {
    await store.saveCustomer("runtime-account","cus_runtime","runtime@example.invalid");
    await store.saveCustomer("runtime-account","cus_ignored",null);
    assert.equal(await second.customerOf("runtime-account"),"cus_runtime");
    assert.equal(await second.accountOfCustomer("cus_runtime"),"runtime-account");
    await store.saveCheckout({sessionId:"cs_runtime",accountId:"runtime-account",kind:"subscription",item:"pro",period:"yearly"});
    await store.completeCheckout("cs_runtime",{paymentIntent:"pi_runtime",subscriptionId:"sub_runtime"});
    assert.equal((await second.checkoutByPaymentIntent("pi_runtime"))!.account_id,"runtime-account");
    await store.saveSubscription({subscriptionId:"sub_runtime",accountId:"runtime-account",planId:"pro",status:"active",periodStart:1700000000000,periodEnd:1702592000000,cancelAtPeriodEnd:true});
    await store.saveSubscription({subscriptionId:"sub_runtime",accountId:"runtime-account",planId:"pro",status:"past_due"});
    const subscription=(await second.latestSubscription("runtime-account"))!;
    assert.equal(subscription.period_start,1700000000000);
    assert.equal(subscription.period_end,1702592000000);
    assert.equal(subscription.status,"past_due");
    assert.equal(await second.periodOf("sub_runtime"),"yearly");
    for(const status of ["processed","failed","ignored"] as const){await store.claimEvent("evt_runtime_"+status,"invoice.paid");await store.finishEvent("evt_runtime_"+status,status,"fixture");}
    assert.equal(await second.claimEvent("evt_runtime_processed","invoice.paid"),false);
    assert.equal(await second.claimEvent("evt_runtime_failed","invoice.paid"),true);
    assert.equal(await second.claimEvent("evt_runtime_ignored","invoice.paid"),true);
    assert.ok((await second.failedEvents(0)).some(e=>e.id==="evt_runtime_failed"));
    assert.equal(typeof (await second.eventStats(0))[0].n,"number");
    assert.equal(typeof await second.lastEventAt(),"number");
    assert.ok((await second.recentEvents(100)).length>=3);
  }finally{await db.close();await other.close();}
});

test("real PostgreSQL composite payment and ledger transaction grants once and rolls back together",{skip:!integration},async()=>{
  const db=await PostgresBillingDatabase.connect(process.env.ORVYN_PG_URL!);
  const other=await PostgresBillingDatabase.connect(process.env.ORVYN_PG_URL!);
  const store=PostgresStripeStore.fromDatabase(db),second=PostgresStripeStore.fromDatabase(other);
  const append=async(owner:PostgresBillingDatabase,id:string)=>owner.prepare(`INSERT INTO ledger_entries
    (id,account_id,type,bucket,amount,idempotency_key,meta,created_at)
    VALUES (?,'runtime-account','topup_purchase','purchased',333,?,'{}',1700000000000)`).run(id,id);
  const event=async(owner:PostgresBillingDatabase,payments:PostgresStripeStore)=>owner.transaction(async()=>{
    if(!await payments.claimEvent("evt_runtime_atomic","checkout.session.completed"))return false;
    await append(owner,"runtime-atomic-credit");
    await payments.finishEvent("evt_runtime_atomic","processed");return true;
  });
  try{
    const results=await Promise.all([event(db,store),event(other,second)]);
    assert.equal(results.filter(Boolean).length,1);
    const total=await db.transaction(()=>db.prepare("SELECT sum(amount) AS n FROM ledger_entries WHERE id=?").get("runtime-atomic-credit"));
    assert.equal(total.n,333);
    await assert.rejects(db.transaction(async()=>{
      await store.claimEvent("evt_runtime_rollback","invoice.paid");
      await append(db,"runtime-rolled-back-credit");
      await store.finishEvent("evt_runtime_rollback","processed");throw new Error("forced application failure");
    }),/forced application failure/);
    assert.equal(await second.eventStatus("evt_runtime_rollback"),null);
    assert.equal(await other.transaction(()=>other.prepare("SELECT id FROM ledger_entries WHERE id=?").get("runtime-rolled-back-credit")),undefined);
    // PostgreSQL COMMIT on an aborted transaction returns ROLLBACK: never acknowledge this as a success.
    await assert.rejects(db.transaction(async()=>{
      await store.claimEvent("evt_runtime_aborted","invoice.paid");
      try{await append(db,"runtime-atomic-credit");}catch{/* simulate a caller catching the SQL failure */}
    }),/not committed/);
    assert.equal(await second.eventStatus("evt_runtime_aborted"),null);
    await assert.rejects(db.prepare("SELECT 1").get(),/outside active transaction/);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let detached!:Promise<unknown>;
    await db.transaction(async()=>{detached=gate.then(()=>store.customerOf("runtime-account"));});
    release();await assert.rejects(detached,/already finished/);
  }finally{await db.close();await other.close();}
});

test("real PostgreSQL billing initialization refuses incompatible ledger storage without local fallback",{skip:!integration},async()=>{
  const pool=new Pool({connectionString:process.env.ORVYN_PG_URL});
  try{
    await pool.query("ALTER TABLE orvyn_billing.wallets ADD COLUMN runtime_future_column TEXT");
    try{await assert.rejects(PostgresBillingDatabase.connect(process.env.ORVYN_PG_URL!),/schema differs/);}
    finally{await pool.query("ALTER TABLE orvyn_billing.wallets DROP COLUMN runtime_future_column");}
  }finally{await pool.end();}
});
