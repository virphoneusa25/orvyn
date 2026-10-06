import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { PostgresLedgerStorage } from "./PostgresLedgerStorage";
import { PostgresStripeStorage } from "./PostgresStripeStorage";

/** Translate only the SQLite syntax used by payment operations. */
export function paymentSql(sql:string):string {
  if (/INSERT OR REPLACE/i.test(sql)) throw new Error("Unsupported payment replacement statement");
  if (/INSERT OR IGNORE/i.test(sql)) sql=sql.replace(/INSERT OR IGNORE/i,"INSERT")+" ON CONFLICT DO NOTHING";
  // PostgreSQL upsert RHS needs qualification when both existing and excluded rows expose a column.
  sql=sql.replace(/COALESCE\(excluded\.(period_start|period_end),\s*\1\)/g,"COALESCE(excluded.$1, stripe_subscriptions.$1)");
  let quoted=false,index=0,result="";
  for(let offset=0;offset<sql.length;offset++) {
    const character=sql[offset];
    if(character==="'") {
      if(quoted&&sql[offset+1]==="'"){result+="''";offset++;continue;}
      quoted=!quoted;
    }
    result+=character==="?"&&!quoted ? `$${++index}` : character;
  }
  return result;
}

/** One transaction owner for ledger and payment schemas. No local fallback. */
export class PostgresBillingDatabase {
  private context=new AsyncLocalStorage<{client:PoolClient;active:boolean}>();
  private pool:Pool;
  private constructor(url:string) {
    this.pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,
      statement_timeout:10000,lock_timeout:5000,idleTimeoutMillis:30000});
  }
  static async connect(url:string):Promise<PostgresBillingDatabase> {
    // Validate both contracts before making this owner available to callers.
    const ledger=new PostgresLedgerStorage(url),payments=new PostgresStripeStorage(url);
    try {
      await ledger.init();await ledger.exportSnapshot();
      await payments.init();await payments.exportSnapshot();
    } finally {await Promise.all([ledger.close(),payments.close()]);}
    return new PostgresBillingDatabase(url);
  }
  async transaction<T>(operation:()=>Promise<T>):Promise<T> {
    const inherited=this.context.getStore();
    if(inherited) {if(!inherited.active)throw new Error("Billing transaction already finished");return operation();}
    const client=await this.pool.connect();let discard:Error|undefined;
    const frame={client,active:true};
    try {
      await client.query("BEGIN");
      // Same locks as migration tooling; acquire them in this order everywhere.
      await client.query("SELECT pg_advisory_xact_lock(730021,3)");
      await client.query("SELECT pg_advisory_xact_lock(730021,4)");
      await client.query("SET LOCAL search_path=pg_catalog,orvyn_billing,orvyn_payments");
      const result=await this.context.run(frame,operation);
      const committed=await client.query("COMMIT");
      if(committed.command!=="COMMIT")throw new Error("Billing transaction was not committed");
      return result;
    }catch(error){
      try{await client.query("ROLLBACK");}catch{discard=new Error("Billing transaction connection failed");}
      throw error;
    }finally{frame.active=false;client.release(discard);}
  }
  prepare(sql:string) {
    const query=async(values:unknown[])=>{
      const frame=this.context.getStore();if(!frame||!frame.active)throw new Error("Billing query outside active transaction");
      const result=await frame.client.query(paymentSql(sql),values);
      for(const row of result.rows)for(const field of result.fields) {
        if(![20,1700].includes(field.dataTypeID)||row[field.name]===null)continue;
        const number=Number(row[field.name]);
        if(!Number.isSafeInteger(number))throw new Error("Billing integer exceeds supported range");
        row[field.name]=number;
      }
      return result;
    };
    return {
      get:async(...values:unknown[])=>(await query(values)).rows[0],
      all:async(...values:unknown[])=>(await query(values)).rows,
      run:async(...values:unknown[])=>({changes:(await query(values)).rowCount??0}),
    };
  }
  async close():Promise<void>{await this.pool.end();}
}
