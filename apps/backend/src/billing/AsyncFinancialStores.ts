import type {CreditLedger} from "./CreditLedger";
import type {StripeStore} from "./stripe";
import type {AsyncOperations} from "../auth/asyncOperations";

export type AsyncCreditLedger=Omit<AsyncOperations<CreditLedger>,"close"|"onAutoRecharge"|"reserveImage">&{
  onAutoRecharge:CreditLedger["onAutoRecharge"];
  reserveImage:(...args:Parameters<CreditLedger["reserveImage"]>)=>Promise<()=>Promise<void>>;
};
export type AsyncPaymentStore=AsyncOperations<Omit<StripeStore,"db">>;
export type FinancialTransaction=<T>(operation:()=>Promise<T>)=>Promise<T>;
export interface AsyncFinancialStores{ledger:AsyncCreditLedger;payments:AsyncPaymentStore;transaction:FinancialTransaction;}
type FinancialBackend={ledger:CreditLedger|AsyncCreditLedger;payments:StripeStore|AsyncPaymentStore;transaction?:FinancialTransaction};

/** Resolve both financial stores once, preserving binding and consistent initialization failure. */
export function createAsyncFinancialStores(load:()=>FinancialBackend|Promise<FinancialBackend>):AsyncFinancialStores {
  let owner:Promise<FinancialBackend>|undefined;
  const listeners=new Set<Parameters<CreditLedger["onAutoRecharge"]>[0]>();
  const ready=()=>owner??=Promise.resolve().then(load).then(backend=>{
    backend.ledger.onAutoRecharge((account,pack)=>{for(const listener of listeners)try{listener(account,pack);}catch{/* listener owns its failure handling */}});
    return backend;
  });
  const ledger=new Proxy({} as AsyncCreditLedger,{get(_target,key){
    if(key==="onAutoRecharge")return (listener:Parameters<CreditLedger["onAutoRecharge"]>[0])=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
    return async(...args:unknown[])=>{
      const backend=await ready();const operation=Reflect.get(backend.ledger,key);
      if(typeof operation!=="function")throw new Error("Unknown financial operation");
      const result=await operation.apply(backend.ledger,args);
      if(key==="reserveImage")return async()=>{await result();};
      return result;
    };
  }});
  const payments=new Proxy({} as AsyncPaymentStore,{get(_target,key){return async(...args:unknown[])=>{
    const backend=await ready();const operation=Reflect.get(backend.payments,key);
    if(typeof operation!=="function")throw new Error("Unknown financial operation");
    return operation.apply(backend.payments,args);
  };}});
  return {ledger,payments,transaction:async operation=>{const backend=await ready();return backend.transaction?backend.transaction(operation):operation();}};
}

// PostgreSQL selection stays blocked until billing callers, reporting and recovery are complete.
const configured=createAsyncFinancialStores(async()=>{
  const ledger=await import("./creditLedgerInstance");const stripe=await import("./stripe");
  return {ledger:ledger.creditLedger,payments:stripe.stripeStore()};
});
export const creditLedger=configured.ledger;
export function paymentStore():AsyncPaymentStore{return configured.payments;}
export const financialTransaction=configured.transaction;
