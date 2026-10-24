import type {PostgresBillingDatabase} from "./PostgresBillingDatabase";
import type {AsyncCreditLedger} from "./AsyncFinancialStores";
import type {UsageEvent} from "../services/UsageService";
import {settleProviderUsage} from "./providerSettlement";

/** Shares the financial transaction owner: acknowledgement and settlement commit together. */
export class PostgresBillingOutbox {
  constructor(private database:PostgresBillingDatabase,private accountId:string,private ledger:AsyncCreditLedger) {
    if(!accountId)throw new Error("Billing outbox requires an account");
  }

  static async init(database:PostgresBillingDatabase):Promise<void> {
    await database.transaction(async()=>{
      await database.prepare("CREATE SCHEMA IF NOT EXISTS orvyn_recovery").run();
      await database.prepare(`CREATE TABLE IF NOT EXISTS orvyn_recovery.billing_outbox (
        account_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(account_id,id))`).run();
      await database.prepare(`CREATE TABLE IF NOT EXISTS orvyn_recovery.release_outbox (
        account_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(account_id,run_id))`).run();
    });
  }

  async enqueueBilling(event:UsageEvent,own:boolean):Promise<void> {
    if(!event.id)throw new Error("Usage event requires an id");
    const payload=JSON.stringify({event,own});
    await this.database.transaction(async()=>{
      const existing=await this.database.prepare("SELECT payload FROM orvyn_recovery.billing_outbox WHERE account_id=? AND id=?").get(this.accountId,event.id);
      if(existing&&existing.payload!==payload)throw new Error("Pending usage identity conflicts with existing billing payload");
      await this.database.prepare("INSERT INTO orvyn_recovery.billing_outbox(account_id,id,payload) VALUES (?,?,?) ON CONFLICT DO NOTHING").run(this.accountId,event.id,payload);
    });
  }

  pendingBilling():Promise<Array<{event:UsageEvent;own:boolean}>> {
    return this.database.transaction(async()=>{
      const rows=await this.database.prepare("SELECT payload FROM orvyn_recovery.billing_outbox WHERE account_id=? ORDER BY id").all(this.accountId);
      return rows.map(row=>JSON.parse(row.payload));
    });
  }

  completeBilling(id:string):Promise<void> {
    return this.database.transaction(async()=>{await this.database.prepare("DELETE FROM orvyn_recovery.billing_outbox WHERE account_id=? AND id=?").run(this.accountId,id);});
  }

  settle(event:UsageEvent,own:boolean,strict:boolean,_ledger:AsyncCreditLedger):Promise<void> {
    return this.database.transaction(async()=>{
      const pending=await this.database.prepare("SELECT payload FROM orvyn_recovery.billing_outbox WHERE account_id=? AND id=?").get(this.accountId,event.id);
      if(!pending)return;
      if(pending.payload!==JSON.stringify({event,own}))throw new Error("Pending usage identity conflicts with settlement");
      const previous=await this.ledger.usageEvent(event.id);
      if(previous&&previous.user_id!==this.accountId)throw new Error("Usage event belongs to another account");
      await settleProviderUsage(this.ledger,this.accountId,event,own,strict);
      await this.completeBilling(event.id);
    });
  }

  /** Preserve legacy pending events until PostgreSQL has durably acknowledged each one. */
  async importLocal(store:{pendingBilling:()=>Array<{event:UsageEvent;own:boolean}>;completeBilling:(id:string)=>void}):Promise<void> {
    for(const pending of store.pendingBilling()) {
      await this.enqueueBilling(pending.event,pending.own);
      store.completeBilling(pending.event.id);
    }
  }

  async releaseRun(runId:string,_ledger:AsyncCreditLedger):Promise<void> {
    await this.database.transaction(async()=>{
      await this.database.prepare("INSERT INTO orvyn_recovery.release_outbox(account_id,run_id) VALUES (?,?) ON CONFLICT DO NOTHING").run(this.accountId,runId);
    });
    await this.database.transaction(async()=>{
      const foreign=await this.database.prepare("SELECT account_id FROM ledger_entries WHERE run_id=? AND account_id<>? LIMIT 1").get(runId,this.accountId);
      if(foreign)throw new Error("Run hold belongs to another account");
      await this.ledger.release(runId);
      await this.completeRelease(runId);
    });
  }

  completeRelease(runId:string):Promise<void> {
    return this.database.transaction(async()=>{await this.database.prepare("DELETE FROM orvyn_recovery.release_outbox WHERE account_id=? AND run_id=?").run(this.accountId,runId);});
  }

  async recoverReleases(ledger:AsyncCreditLedger):Promise<void> {
    const rows=await this.database.transaction(()=>this.database.prepare("SELECT run_id FROM orvyn_recovery.release_outbox WHERE account_id=? ORDER BY run_id").all(this.accountId));
    for(const row of rows)await this.releaseRun(row.run_id,ledger);
  }
}
