import {PostgresBillingDatabase} from "./PostgresBillingDatabase";
import {PostgresCreditLedger} from "./PostgresCreditLedger";
import {PostgresStripeStore} from "./PostgresStripeStore";
import {PostgresBillingOutbox} from "./PostgresBillingOutbox";

/** Own and close one pool for all internal payment and credit operations. */
export class PostgresFinancialStores {
  readonly ledger:PostgresCreditLedger;
  readonly payments:PostgresStripeStore;
  private constructor(private database:PostgresBillingDatabase) {
    this.ledger=PostgresCreditLedger.fromDatabase(database);
    this.payments=PostgresStripeStore.fromDatabase(database);
  }
  static async connect(url:string):Promise<PostgresFinancialStores> {
    const stores=new PostgresFinancialStores(await PostgresBillingDatabase.connect(url));
    try{await PostgresBillingOutbox.init(stores.database);await stores.ledger.seedDefaultRateCard();return stores;}
    catch(error){await stores.close();throw error;}
  }
  transaction<T>(operation:(stores:PostgresFinancialStores)=>Promise<T>):Promise<T> {
    return this.database.transaction(()=>operation(this));
  }
  outbox(accountId:string):PostgresBillingOutbox{return new PostgresBillingOutbox(this.database,accountId,this.ledger);}
  close():Promise<void>{return this.database.close();}
}
