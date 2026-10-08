export type StorageConfiguration = {mode:"sqlite"} | {mode:"postgres";url:string};
/** One all-or-nothing selection for identity, money, tenant data and sessions. */
export function storageConfiguration(env:NodeJS.ProcessEnv=process.env):StorageConfiguration {
 const reads=env.ORVYN_POSTGRES_PRIMARY_READS?.trim()==="1",writes=env.ORVYN_POSTGRES_PRIMARY_WRITES?.trim()==="1";
 if(!reads&&!writes)return {mode:"sqlite"};
 if(!reads||!writes)throw new Error("Partial PostgreSQL primary selection is unsupported; mirror only until reads and writes switch together.");
 if(env.ORVYN_POSTGRES_MIRROR?.trim()==="1")throw new Error("PostgreSQL primary requires the legacy SQLite mirror to be disabled.");
 if(env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE?.trim()!=="0")throw new Error("PostgreSQL primary requires SQLite read fallback explicitly disabled.");
 const url=env.DATABASE_URL?.trim()||env.ORVYN_PG_URL?.trim();
 if(!url)throw new Error("PostgreSQL primary requires DATABASE_URL or ORVYN_PG_URL.");
 return {mode:"postgres",url};
}
