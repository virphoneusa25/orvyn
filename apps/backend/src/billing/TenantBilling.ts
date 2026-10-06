import type {AsyncCreditLedger} from "./AsyncFinancialStores";
import type {UsageEvent} from "../services/UsageService";
import {settleProviderUsage} from "./providerSettlement";
import {customerCreditsFor} from "./creditMath";
import {planById,LANE_FACTORS} from "./plans";

export interface BillingOutbox {
  pendingBilling:()=>Array<{event:UsageEvent;own:boolean}>|Promise<Array<{event:UsageEvent;own:boolean}>>;
  enqueueBilling:(event:UsageEvent,own:boolean)=>void|Promise<void>;
  completeBilling:(id:string)=>void|Promise<void>;
  settle?:(event:UsageEvent,own:boolean,strict:boolean,ledger:AsyncCreditLedger)=>Promise<void>;
  releaseRun?:(runId:string,ledger:AsyncCreditLedger)=>Promise<void>;
  recoverReleases?:(ledger:AsyncCreditLedger)=>Promise<void>;
}

/** Keep durable usage pending until the ledger acknowledges it; order run holds and cleanup. */
export class TenantBilling {
  private recovering?:Promise<void>;
  private admissions=new Map<string,Promise<void>>();
  constructor(private ledger:AsyncCreditLedger,private accountId:string,
    private store:BillingOutbox) {}

  async record(event:UsageEvent,own:boolean,strict:boolean):Promise<void> {
    await this.store.enqueueBilling(event,own);
    await this.settle(event,own,strict);
  }

  private async settle(event:UsageEvent,own:boolean,strict:boolean):Promise<void> {
    if(this.store.settle)return this.store.settle(event,own,strict,this.ledger);
    await settleProviderUsage(this.ledger,this.accountId,event,own,strict);
    await this.store.completeBilling(event.id);
  }

  recover(strict:boolean):Promise<void> {
    if(!this.recovering)this.recovering=(async()=>{
      for(const pending of await this.store.pendingBilling()) {
        await this.settle(pending.event,pending.own,strict);
      }
      if((await this.store.pendingBilling()).length)throw new Error("Billing recovery is still pending.");
      await this.store.recoverReleases?.(this.ledger);
    })().finally(()=>{this.recovering=undefined;});
    return this.recovering;
  }

  reserveRun(runId:string):Promise<void> {
    const existing=this.admissions.get(runId);if(existing)return existing;
    const admission=(async()=>{
      const available=(await this.ledger.snapshot(this.accountId)).availableBalance;
      const plan=planById(await this.ledger.planOf(this.accountId)??"free");
      const budget=customerCreditsFor(plan.perRunCostUsd,LANE_FACTORS.auto).customerCredits;
      const hold=Math.min(budget,available);
      if(hold>0)await this.ledger.reserve(this.accountId,runId,hold);
    })();
    this.admissions.set(runId,admission);
    return admission;
  }

  async awaitRun(runId?:string):Promise<void> {
    if(runId)await this.admissions.get(runId);
  }

  async releaseRun(runId:string):Promise<void> {
    try {
      try{await this.awaitRun(runId);}catch{/* still release any hold left by an interrupted admission */}
      if(this.store.releaseRun)await this.store.releaseRun(runId,this.ledger);
      else await this.ledger.release(runId);
    }finally{this.admissions.delete(runId);}
  }
}
