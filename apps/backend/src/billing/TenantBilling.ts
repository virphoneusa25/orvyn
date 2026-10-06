import type {AsyncCreditLedger} from "./AsyncFinancialStores";
import type {UsageEvent} from "../services/UsageService";
import type {LocalStore} from "../persistence/LocalStore";
import {settleProviderUsage} from "./providerSettlement";
import {customerCreditsFor} from "./creditMath";
import {planById,LANE_FACTORS} from "./plans";

/** Keep durable usage pending until the ledger acknowledges it; order run holds and cleanup. */
export class TenantBilling {
  private recovering?:Promise<void>;
  private admissions=new Map<string,Promise<void>>();
  constructor(private ledger:AsyncCreditLedger,private accountId:string,
    private store:Pick<LocalStore,"pendingBilling"|"enqueueBilling"|"completeBilling">) {}

  async record(event:UsageEvent,own:boolean,strict:boolean):Promise<void> {
    this.store.enqueueBilling(event,own);
    await settleProviderUsage(this.ledger,this.accountId,event,own,strict);
    this.store.completeBilling(event.id);
  }

  recover(strict:boolean):Promise<void> {
    if(!this.recovering)this.recovering=(async()=>{
      for(const pending of this.store.pendingBilling()) {
        await settleProviderUsage(this.ledger,this.accountId,pending.event,pending.own,strict);
        this.store.completeBilling(pending.event.id);
      }
      if(this.store.pendingBilling().length)throw new Error("Billing recovery is still pending.");
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
      await this.ledger.release(runId);
    }finally{this.admissions.delete(runId);}
  }
}
