import { storageConfiguration } from "./storageConfiguration";
import type {PostgresAccountStores} from "../auth/PostgresAccountStores";
import type {PostgresFinancialStores} from "../billing/PostgresFinancialStores";
import type {PostgresAdminService} from "../admin/PostgresAdminService";

export interface PostgresRuntime {accounts:PostgresAccountStores;financial:PostgresFinancialStores;reports:PostgresAdminService;close():Promise<void>;}
/** Initialize once; failure is sticky and never falls back to SQLite. */
export function createPostgresRuntime(load:()=>Promise<PostgresRuntime>):()=>Promise<PostgresRuntime> {
 let owner:Promise<PostgresRuntime>|undefined;
 return ()=>owner??=Promise.resolve().then(load);
}
let selected:ReturnType<typeof storageConfiguration>|undefined;
export const selectedStorage=()=>selected??=storageConfiguration();
export const postgresRuntime=createPostgresRuntime(async()=>{
 const config=selectedStorage();if(config.mode!=="postgres")throw new Error("PostgreSQL primary is not selected");
 const {PostgresAccountStores}=await import("../auth/PostgresAccountStores");
 const {PostgresFinancialStores}=await import("../billing/PostgresFinancialStores");
 const {PostgresAdminDatabase}=await import("../admin/PostgresAdminDatabase");
 const {PostgresAdminService}=await import("../admin/PostgresAdminService");
 const accounts=await PostgresAccountStores.connect(config.url);
 let financial:PostgresFinancialStores|undefined;let reports:PostgresAdminService|undefined;
 try{
  financial=await PostgresFinancialStores.connect(config.url);
  reports=new PostgresAdminService(new PostgresAdminDatabase(config.url),financial.ledger,financial.payments,accounts.staff);
  await reports.ping();
  const owner={accounts,financial,reports};
  return {...owner,close:async()=>{await Promise.all([owner.reports.close(),owner.financial.close(),owner.accounts.close()]);}};
 }catch(error){await Promise.allSettled([accounts.close(),financial?.close(),reports?.close()]);throw error;}
});
export async function openTenantStorage(id:string){
 const config=selectedStorage();
 if(config.mode==="postgres"){await postgresRuntime();return (await import("./PostgresTenantStore")).PostgresTenantStore.connect(config.url,id);}
 return new (await import("./LocalStore")).LocalStore(id);
}
export async function openSessionStorage(id:string){
 const config=selectedStorage();
 if(config.mode==="postgres"){await postgresRuntime();return (await import("../sessions/PostgresWorkSessionStore")).PostgresWorkSessionStore.connect(config.url,id);}
 return new (await import("../sessions/WorkSessionStore")).WorkSessionStore(id);
}
