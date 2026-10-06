import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CreditLedger} from "./CreditLedger";
import {StripeStore,BillingService,signStripePayload} from "./stripe";
import {createAsyncFinancialStores} from "./AsyncFinancialStores";

test("financial boundaries initialize once across concurrent credit, payment and transaction calls",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"financial-boundary-"));
  const ledger=new CreditLedger(join(dir,"billing.sqlite")),payments=new StripeStore(join(dir,"payments.sqlite"));
  let loads=0;
  const stores=createAsyncFinancialStores(async()=>{loads++;return {ledger,payments};});
  try{
    await Promise.all([stores.ledger.ensureAccount("boundary"),stores.payments.saveCustomer("boundary","cus_boundary","fixture@example.test"),stores.transaction(async()=>{})]);
    assert.equal(loads,1);
    assert.equal(await stores.ledger.planOf("boundary"),"free");
    assert.equal(await stores.payments.customerOf("boundary"),"cus_boundary");
    const release=await stores.ledger.reserveImage("boundary",2,"image",0.01);
    await assert.rejects(stores.ledger.reserveImage("boundary",2,"image",0.01));
    await release();await release();
    const next=await stores.ledger.reserveImage("boundary",2,"image",0.01);await next();
  }finally{ledger.close();payments.db.close();rmSync(dir,{recursive:true,force:true});}
});

test("financial initialization failure is shared without independently selecting a fallback",async()=>{
  const failure=new Error("fixture initialization failure");let loads=0;
  const stores=createAsyncFinancialStores(async()=>{loads++;throw failure;});
  const results=await Promise.allSettled([stores.ledger.planOf("fixture"),stores.payments.customerOf("fixture"),stores.transaction(async()=>{})]);
  for(const result of results){assert.equal(result.status,"rejected");if(result.status==="rejected")assert.equal(result.reason,failure);}
  await assert.rejects(stores.ledger.snapshot("fixture"),error=>error===failure);
  assert.equal(loads,1);
});

test("billing waits for payment completion and runs notifications after transaction acknowledgement",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"webhook-boundary-"));
  const ledger=new CreditLedger(join(dir,"billing.sqlite")),payments=new StripeStore(join(dir,"payments.sqlite"));
  let committed=false,notifications=0;
  const stores=createAsyncFinancialStores(()=>({ledger,payments,transaction:async operation=>{const result=await operation();committed=true;return result;}}));
  const service=new BillingService({secretKey:"sk_fixture",webhookSecret:"whsec_fixture",apiBase:"http://127.0.0.1:9",publicOrigin:"https://fixture.example"},stores.payments,stores.ledger,{paymentSucceeded:()=>{assert.equal(committed,true);notifications++;throw new Error("fixture notification failure");}},{} as NodeJS.ProcessEnv,stores.transaction);
  try{
    await stores.ledger.ensureAccount("webhook-boundary");
    const event={id:"evt_boundary",type:"checkout.session.completed",data:{object:{id:"cs_boundary",mode:"payment",payment_status:"paid",payment_intent:"pi_boundary",amount_total:1000,metadata:{accountId:"webhook-boundary",kind:"topup",packId:"pack_10k"}}}};
    const raw=Buffer.from(JSON.stringify(event)),signature=signStripePayload(raw.toString("utf8"),"whsec_fixture");
    assert.equal((await service.handleWebhook(raw,signature)).status,200);
    assert.equal((await stores.ledger.snapshot("webhook-boundary")).purchasedBalance,10000);
    assert.equal(notifications,1);
    assert.equal((await service.handleWebhook(raw,signature)).body.duplicate,true);
    assert.equal(notifications,1);
  }finally{ledger.close();payments.db.close();rmSync(dir,{recursive:true,force:true});}
});
