import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CreditLedger,BillingLimitError} from "./CreditLedger";
import {PostgresCreditLedger} from "./PostgresCreditLedger";
import {PostgresFinancialStores} from "./PostgresFinancialStores";
import {paymentSql} from "./PostgresBillingDatabase";
import {createAsyncFinancialStores} from "./AsyncFinancialStores";
import {BillingService,signStripePayload} from "./stripe";

const integration=process.env.ORVYN_LEDGER_RUNTIME_TEST==="1"&&Boolean(process.env.ORVYN_PG_URL);
const now=Date.UTC(2026,9,12),day=86400000;
test("real PostgreSQL webhook commits payment and credits together, rolls back failed acknowledgement and safely retries",{skip:!integration},async()=>{
  const owner=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  const observer=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  let rejectCommit=true,notifications=0;
  const stores=createAsyncFinancialStores(()=>({ledger:owner.ledger,payments:owner.payments,transaction:operation=>owner.transaction(async()=>{
    const result=await operation();
    if(rejectCommit){rejectCommit=false;throw new Error("fixture acknowledgement rejection");}
    return result;
  })}));
  const account="runtime-webhook-atomic";
  const service=new BillingService({secretKey:"sk_fixture",webhookSecret:"whsec_fixture",apiBase:"http://127.0.0.1:9",publicOrigin:"https://fixture.example"},stores.payments,stores.ledger,{paymentSucceeded:()=>{notifications++;}},{} as NodeJS.ProcessEnv,stores.transaction);
  const event={id:"evt_runtime_ledger_webhook",type:"checkout.session.completed",data:{object:{id:"cs_runtime_atomic",mode:"payment",payment_status:"paid",customer:"cus_runtime_atomic",payment_intent:"pi_runtime_atomic",amount_total:1000,metadata:{accountId:account,kind:"topup",packId:"pack_10k"}}}};
  const raw=Buffer.from(JSON.stringify(event)),signature=signStripePayload(raw.toString("utf8"),"whsec_fixture");
  try{
    await owner.ledger.ensureAccount(account);
    assert.equal((await service.handleWebhook(raw,signature)).status,500);
    assert.equal(await observer.payments.eventStatus(event.id),"failed");
    assert.equal(await observer.payments.customerOf(account),null);
    assert.equal(await observer.payments.checkoutByPaymentIntent("pi_runtime_atomic"),undefined);
    assert.equal((await observer.ledger.snapshot(account)).purchasedBalance,0);
    assert.equal(notifications,0);
    assert.equal((await service.handleWebhook(raw,signature)).status,200);
    assert.equal(await observer.payments.eventStatus(event.id),"processed");
    assert.equal(await observer.payments.customerOf(account),"cus_runtime_atomic");
    assert.equal((await observer.ledger.snapshot(account)).purchasedBalance,10000);
    assert.equal(notifications,1);
    const replay=await Promise.all([service.handleWebhook(raw,signature),service.handleWebhook(raw,signature)]);
    assert.ok(replay.every(result=>result.status===200&&result.body.duplicate===true));
    assert.equal((await observer.ledger.snapshot(account)).purchasedBalance,10000);
    assert.equal(notifications,1);
  }finally{await owner.close();await observer.close();}
});
test("ledger SQL rewrites SQLite aggregate aliases and retains the existing billing error identity",()=>{
  assert.match(paymentSql("SELECT run_id,SUM(amount) AS n FROM ledger_entries GROUP BY run_id HAVING n > 0"),/HAVING SUM\(amount\) > 0/);
  assert.match(paymentSql("SELECT input_tokens AS inputTokens"),/AS "inputTokens"/);
  assert.equal(new BillingLimitError("BALANCE","fixture").billing,true);
});

test("real PostgreSQL ledger matches SQLite grants, versioned rates, holds, settlements, refunds and usage reports",{skip:!integration},async()=>{
  const stores=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  const dir=mkdtempSync(join(tmpdir(),"ledger-parity-"));const local=new CreditLedger(join(dir,"billing.sqlite"));
  const account="runtime-ledger-parity";
  async function scenario(ledger:CreditLedger|PostgresCreditLedger) {
    await ledger.ensureAccount(account,"starter",now);
    await ledger.creditPurchase(account,"pack_10k",{paymentRef:"runtime-parity-payment"},now);
    await ledger.reserve(account,"runtime-parity-run",500,now);
    const reserved=await ledger.snapshot(account,now);
    await ledger.setRateCard({provider:"fixture",modelId:"model",inputUsdPerMillion:1.1,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:2.2,effectiveFrom:now});
    await ledger.setRateCard({provider:"fixture",modelId:"model",inputUsdPerMillion:2.2,cachedInputUsdPerMillion:0.2,outputUsdPerMillion:4.4,effectiveFrom:now+1000});
    const input={userId:account,runId:"runtime-parity-run",eventId:"runtime-parity-usage",type:"model" as const,lane:"auto" as const,provider:"fixture",model:"model",inputTokens:10000,cachedInputTokens:1000,outputTokens:2000,rateAt:now+1,now:now+2000,requireExactRate:true};
    const charged=await ledger.charge(input),replayed=await ledger.charge(input);
    await ledger.release("runtime-parity-run",now+2100);
    const failed=await ledger.charge({...input,eventId:"runtime-parity-failed",ok:false,now:now+2200});
    await ledger.refund(account,700,{paymentRef:"runtime-parity-refund"},now+2300);
    await ledger.adminAdjust(account,33,{actor:"fixture",reason:"parity",key:"runtime-parity-adjustment"},now+2400);
    return {reserved,charged,replayed,failed,snapshot:await ledger.snapshot(account,now+3000),stats:await ledger.usageStats(account,now+3000),verify:await ledger.verify(account)};
  }
  try{
    assert.deepEqual(JSON.parse(JSON.stringify(await scenario(stores.ledger))),JSON.parse(JSON.stringify(await scenario(local))));
    assert.ok((await stores.ledger.accounts()).some(a=>a.accountId===account&&typeof a.available==="number"));
    assert.equal((await stores.ledger.usageEvent("runtime-parity-usage"))!.ok,1);
    assert.ok((await stores.ledger.listRateCards()).some(c=>c.modelId==="model"));
    await assert.rejects(stores.ledger.assertCanSpend(account,undefined,now,{lane:"ultra"}),e=>e instanceof BillingLimitError&&e.code==="ENTITLEMENT");
  }finally{local.close();rmSync(dir,{recursive:true,force:true});await stores.close();}
});

test("real PostgreSQL ledger serializes duplicate topups, subscription grants and competing reservations",{skip:!integration},async()=>{
  const one=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!),two=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  const account="runtime-ledger-concurrent";
  try{
    await one.ledger.ensureAccount(account,undefined,now);
    const credits=await Promise.all([one.ledger.creditPurchase(account,"pack_10k",{paymentRef:"runtime-concurrent-payment"},now),two.ledger.creditPurchase(account,"pack_10k",{paymentRef:"runtime-concurrent-payment"},now)]);
    assert.equal(credits.filter(c=>!c.duplicate).length,1);
    const subscription={accountId:account,planId:"pro" as const,subscriptionId:"sub_runtime_ledger",periodStart:now,periodEnd:now+30*day,status:"active"};
    const grants=await Promise.all([one.ledger.applySubscription(subscription,now),two.ledger.applySubscription(subscription,now)]);
    assert.equal(grants.filter(g=>g.granted).length,1);
    assert.equal((await one.ledger.grantsIssued(account)).length,2);
    assert.equal(await two.ledger.subscriptionIdOf(account),subscription.subscriptionId);
    assert.equal((await two.ledger.subscriptionOf(account))!.status,"active");
    const reserves=await Promise.allSettled([one.ledger.reserve(account,"runtime-hold-a",45000,now),two.ledger.reserve(account,"runtime-hold-b",45000,now)]);
    assert.equal(reserves.filter(r=>r.status==="fulfilled").length,1);
    assert.ok((await two.ledger.verify(account)).ok);
    await one.ledger.release("runtime-hold-a",now);await two.ledger.release("runtime-hold-b",now);
    await one.ledger.endSubscription(account,subscription.subscriptionId,now+1);
    assert.equal(await two.ledger.planOf(account),"free");
    const free="runtime-ledger-free-cycle";await one.ledger.ensureAccount(free,undefined,now);
    await two.ledger.ensureAccount(free,undefined,now+31*day);await one.ledger.ensureAccount(free,undefined,now+31*day);
    assert.equal((await two.ledger.grantsIssued(free)).length,2);
    assert.equal((await one.ledger.snapshot(free,now+31*day)).includedBalance,2000);
  }finally{await one.close();await two.close();}
});

test("real PostgreSQL image reservations release asynchronously and rolling quotas retain existing errors",{skip:!integration},async()=>{
  const stores=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  try{
    const account="runtime-ledger-images";await stores.ledger.ensureAccount(account,undefined,now);
    await stores.ledger.setImageRateCard("fixture","image",{usdPerImage:0.01,source:"fixture",verifiedAt:now});
    const release=await stores.ledger.reserveImage(account,2,"image",0.01,now);
    await assert.rejects(stores.ledger.reserveImage(account,2,"image",0.01,now),e=>e instanceof BillingLimitError&&e.code==="IMAGE_BURST");
    await release();await release();
    const next=await stores.ledger.reserveImage(account,2,"image",0.01,now);await next();
    await stores.ledger.charge({userId:account,eventId:"runtime-image-usage",type:"image",provider:"fixture",model:"image",lane:"image",providerCostUsd:0.01,imageCount:3,now});
    await assert.rejects(stores.ledger.assertCanSpend(account,undefined,now,{type:"image",lane:"image"}),e=>e instanceof BillingLimitError&&e.code==="IMAGE_BURST");
    const quota="runtime-ledger-quota";await stores.ledger.ensureAccount(quota,"pro",now);
    await stores.ledger.charge({userId:quota,eventId:"runtime-quota-usage",type:"model",lane:"utility",providerCostUsd:10,now});
    await assert.rejects(stores.ledger.assertCanSpend(quota,"runtime-quota-run",now),e=>e instanceof BillingLimitError&&["WINDOW_5H","RUN_CAP"].includes(e.code));
    await stores.ledger.assertCanSpend(quota,undefined,now+6*3600000);
    await stores.ledger.charge({userId:quota,eventId:"runtime-quota-week",type:"model",lane:"utility",providerCostUsd:20,now:now+6*3600000});
    await assert.rejects(stores.ledger.assertCanSpend(quota,undefined,now+12*3600000),e=>e instanceof BillingLimitError&&e.code==="WINDOW_7D");
    const run="runtime-ledger-run-cap";await stores.ledger.ensureAccount(run,"pro",now);
    await stores.ledger.charge({userId:run,runId:"runtime-ledger-run",eventId:"runtime-run-cap-usage",type:"model",lane:"utility",providerCostUsd:1.6,now});
    await assert.rejects(stores.ledger.assertCanSpend(run,"runtime-ledger-run",now+1),e=>e instanceof BillingLimitError&&e.code==="RUN_CAP");
    await stores.ledger.authorizeRun(run,"runtime-ledger-run");
    await stores.ledger.assertCanSpend(run,"runtime-ledger-run",now+1);
    assert.ok((await stores.ledger.verify(quota)).ok);
  }finally{await stores.close();}
});

test("real PostgreSQL full ledger joins payment commits and recharge callbacks fire only after outer commit",{skip:!integration},async()=>{
  const stores=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!),other=await PostgresFinancialStores.connect(process.env.ORVYN_PG_URL!);
  const account="runtime-ledger-recharge";const calls:string[]=[];const reads:Promise<unknown>[]=[];
  try{
    await stores.ledger.ensureAccount(account,"starter",now);
    const unsubscribe=stores.ledger.onAutoRecharge((id,pack)=>{calls.push(`${id}:${pack}`);reads.push(other.ledger.snapshot(id,now+1));});
    await stores.ledger.setAutoRecharge(account,{threshold:23900,packId:"pack_10k",maxPerMonth:1},now);
    const charge={userId:account,eventId:"runtime-recharge-usage",type:"model" as const,lane:"auto" as const,providerCostUsd:0.2,now:now+1};
    await assert.rejects(stores.transaction(async s=>{await s.ledger.charge(charge);assert.equal(calls.length,0);throw new Error("rollback recharge");}),/rollback recharge/);
    assert.equal(calls.length,0);assert.equal(await other.ledger.usageEvent(charge.eventId),undefined);
    await stores.transaction(async s=>{await s.ledger.charge(charge);assert.equal(calls.length,0);});
    assert.deepEqual(calls,[`${account}:pack_10k`]);await Promise.all(reads);
    await stores.ledger.charge({...charge,eventId:"runtime-recharge-pending",now:now+2});assert.equal(calls.length,1);
    await assert.rejects(stores.transaction(async s=>{
      await s.payments.claimEvent("evt_runtime_full_rollback","checkout.session.completed");
      await s.ledger.creditPurchase(account,"pack_10k",{paymentRef:"runtime-full-payment",source:"auto_recharge"},now+3);
      await s.payments.finishEvent("evt_runtime_full_rollback","processed");throw new Error("rollback payment");
    }),/rollback payment/);
    assert.equal(await other.payments.eventStatus("evt_runtime_full_rollback"),null);
    assert.equal((await other.ledger.snapshot(account,now+3)).purchasedBalance,0);
    await stores.transaction(async s=>{
      await s.payments.claimEvent("evt_runtime_full_commit","checkout.session.completed");
      await s.ledger.creditPurchase(account,"pack_10k",{paymentRef:"runtime-full-payment",source:"auto_recharge"},now+3);
      await s.payments.finishEvent("evt_runtime_full_commit","processed");
    });
    assert.equal(await other.payments.eventStatus("evt_runtime_full_commit"),"processed");
    assert.equal((await other.ledger.snapshot(account,now+3)).purchasedBalance,10000);
    assert.equal((await other.ledger.snapshot(account,now+3)).autoRecharge!.recharges_this_cycle,1);
    await stores.ledger.adminAdjust(account,-10000,{actor:"fixture",reason:"drain purchased credits",bucket:"purchased",key:"runtime-recharge-drain"},now+4);
    await stores.ledger.charge({...charge,eventId:"runtime-recharge-cap",now:now+4});assert.equal(calls.length,1);
    await stores.ledger.autoRechargeFailed(account);await stores.ledger.disableAutoRecharge(account);unsubscribe();
  }finally{await stores.close();await other.close();}
});
