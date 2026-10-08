import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CreditLedger} from "./CreditLedger";
import {StripeStore} from "./stripe";
import {createAsyncFinancialStores,type AsyncCreditLedger} from "./AsyncFinancialStores";
import {TenantBilling} from "./TenantBilling";
import {LocalStore} from "../persistence/LocalStore";
import type {UsageEvent} from "../services/UsageService";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const event:UsageEvent={id:"tenant-billing-fixture",timestamp:Date.now(),modelId:"fixture",provider:"fixture",method:"generate",durationMs:1,ok:true,providerCostUsd:0.01};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"tenant-billing-")),ledger=new CreditLedger(join(dir,"billing.sqlite")),payments=new StripeStore(join(dir,"payments.sqlite"));
  const stores=createAsyncFinancialStores(()=>({ledger,payments}));
  return {dir,ledger,stores,close:()=>{ledger.close();payments.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test("durable usage remains pending until the asynchronous credit write is acknowledged",async()=>{
  const f=fixture(),store=new LocalStore("fixture",f.dir),gate=deferred(),entered=deferred();
  const ledger=new Proxy(f.stores.ledger,{get(target,key){if(key==="charge")return async(...args:Parameters<CreditLedger["charge"]>)=>{entered.resolve();await gate.promise;return target.charge(...args);};return Reflect.get(target,key);}});
  const billing=new TenantBilling(ledger,"fixture",store);
  try{
    const result=billing.record(event,false,true);
    await entered.promise;assert.equal(store.pendingBilling().length,1);assert.equal(f.ledger.usageEvent(event.id),undefined);
    gate.resolve();await result;
    assert.equal(store.pendingBilling().length,0);assert.ok(f.ledger.usageEvent(event.id));
  }finally{store.close();f.close();}
});

test("failed acknowledged writes remain durable across restart and shared recovery replays once",async()=>{
  const f=fixture();let store=new LocalStore("fixture",f.dir),available=false,charges=0;
  const ledger=new Proxy(f.stores.ledger,{get(target,key){if(key==="charge")return async(...args:Parameters<CreditLedger["charge"]>)=>{charges++;if(!available)throw new Error("fixture write unavailable");return target.charge(...args);};return Reflect.get(target,key);}});
  try{
    await assert.rejects(new TenantBilling(ledger,"fixture",store).record(event,false,true),/fixture write unavailable/);
    assert.equal(store.pendingBilling().length,1);store.close();store=new LocalStore("fixture",f.dir);
    assert.equal(store.pendingBilling().length,1);
    available=true;const billing=new TenantBilling(ledger,"fixture",store);
    await Promise.all([billing.recover(true),billing.recover(true)]);
    assert.equal(charges,2);assert.equal(store.pendingBilling().length,0);
    const balance=f.ledger.snapshot("fixture").availableBalance;
    await billing.record(event,false,true);assert.equal(f.ledger.snapshot("fixture").availableBalance,balance);
  }finally{store.close();f.close();}
});

test("run admission and terminal cleanup wait for the same reservation before releasing",async()=>{
  const gate=deferred(),entered=deferred(),calls:string[]=[];
  const ledger={snapshot:async()=>({availableBalance:2000}),planOf:async()=>"free",reserve:async()=>{calls.push("reserve-start");entered.resolve();await gate.promise;calls.push("reserved");},release:async()=>{calls.push("released");}} as unknown as AsyncCreditLedger;
  const store={pendingBilling:()=>[],enqueueBilling:()=>{},completeBilling:()=>{}};
  const billing=new TenantBilling(ledger,"fixture",store);
  const admission=billing.reserveRun("fixture-run"),same=billing.reserveRun("fixture-run");assert.equal(admission,same);
  let admitted=false,closed=false;
  const provider=billing.awaitRun("fixture-run").then(()=>{admitted=true;});
  const terminal=billing.releaseRun("fixture-run").then(()=>{closed=true;});
  await entered.promise;assert.equal(admitted,false);assert.equal(closed,false);assert.deepEqual(calls,["reserve-start"]);
  gate.resolve();await Promise.all([admission,provider,terminal]);assert.deepEqual(calls,["reserve-start","reserved","released"]);
});

test("lost settlement acknowledgement survives restart without charging committed usage twice",async()=>{
  const f=fixture();let store=new LocalStore("fixture",f.dir),loseAcknowledgement=true;
  const ledger=new Proxy(f.stores.ledger,{get(target,key){if(key==="charge")return async(...args:Parameters<CreditLedger["charge"]>)=>{
    const result=await target.charge(...args);
    if(loseAcknowledgement){loseAcknowledgement=false;throw new Error("fixture lost acknowledgement");}
    return result;
  };return Reflect.get(target,key);}});
  try{
    await assert.rejects(new TenantBilling(ledger,"fixture",store).record(event,false,true),/fixture lost acknowledgement/);
    assert.equal(store.pendingBilling().length,1);assert.ok(f.ledger.usageEvent(event.id));
    const balance=f.ledger.snapshot("fixture").availableBalance;
    store.close();store=new LocalStore("fixture",f.dir);
    await new TenantBilling(ledger,"fixture",store).recover(true);
    assert.equal(store.pendingBilling().length,0);assert.equal(f.ledger.snapshot("fixture").availableBalance,balance);
  }finally{store.close();f.close();}
});

test("failed run admission prevents provider work and terminal cleanup still releases",async()=>{
  let released=false;
  const ledger={snapshot:async()=>{throw new Error("fixture reservation unavailable");},release:async()=>{released=true;}} as unknown as AsyncCreditLedger;
  const billing=new TenantBilling(ledger,"fixture",{pendingBilling:()=>[],enqueueBilling:()=>{},completeBilling:()=>{}});
  await assert.rejects(billing.reserveRun("fixture-run"),/fixture reservation unavailable/);
  await assert.rejects(billing.awaitRun("fixture-run"),/fixture reservation unavailable/);
  await billing.releaseRun("fixture-run");assert.equal(released,true);
});

test("startup reconciliation releases only provably terminal holds and retries failed releases",async()=>{
 const held=[{runId:"finished",credits:100},{runId:"blocked",credits:100},{runId:"running",credits:100},{runId:"unknown",credits:100}];
 let available=false;const released:string[]=[];
 const ledger={heldRuns:async()=>held,release:async(id:string)=>{if(!available)throw new Error("release unavailable");released.push(id);}} as unknown as AsyncCreditLedger;
 const billing=new TenantBilling(ledger,"fixture",{pendingBilling:()=>[],enqueueBilling(){},completeBilling(){}});
 const status=(id:string)=>id==="finished"?"completed" as const:id==="blocked"?"blocked" as const:id==="running"?"running" as const:undefined;
 await assert.rejects(billing.reconcileRuns(status),/release unavailable/);
 available=true;assert.deepEqual(await billing.reconcileRuns(status),{released:1,unresolved:1});assert.deepEqual(released,["finished"]);
});

test("startup billing recovery drains more than one database page and detects failed acknowledgements",async()=>{
 const pending=new Map(Array.from({length:2050},(_,i)=>[String(i),{event:{...event,id:String(i)},own:true}]));
 let acknowledge=true;
 const billing=new TenantBilling({} as AsyncCreditLedger,"fixture",{pendingBilling:()=>[...pending.values()].slice(0,1000),enqueueBilling(){},completeBilling(){},settle:async(e)=>{if(acknowledge)pending.delete(e.id);}});
 await billing.recover(true);assert.equal(pending.size,0);
 pending.set(event.id,{event,own:true});acknowledge=false;await assert.rejects(billing.recover(true),/still pending/);assert.equal(pending.size,1);
});
