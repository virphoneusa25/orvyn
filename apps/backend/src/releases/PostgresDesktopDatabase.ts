import { AsyncLocalStorage } from "node:async_hooks";
import {DESKTOP_TABLES} from "./desktopReleaseSchema";
import {desktopColumns,validateDesktopSnapshot,desktopFingerprint,type DesktopReleaseSnapshot} from "./DesktopReleaseSnapshot";
import { Pool, type PoolClient } from "pg";

import {POSTGRES_DESKTOP_SCHEMA as SCHEMA} from "./desktopReleaseSchema";
import {encodeTenantText,decodeTenantText,tenantSql} from "../persistence/PostgresTenantDatabase";
// PostgreSQL text cannot contain NUL. Escaping every text binding makes the
// representation reversible, including literal backslashes and JSON strings.
// Fixed SQL literals in the shared session behavior contain neither character.
type Frame={client:PoolClient;active:boolean};
export class PostgresDesktopDatabase {
  private readonly pool:Pool;
  private readonly context=new AsyncLocalStorage<Frame>();
  readonly schema:string;
  private constructor(url:string) {
    this.schema="orvyn_desktop";
    this.pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,
      statement_timeout:10000,lock_timeout:5000,idleTimeoutMillis:30000,
      application_name:"orvyn-desktop-releases"});
    this.pool.on("error",()=>console.warn("[desktop-releases] idle PostgreSQL connection failed"));
  }
  static async connect(url:string):Promise<PostgresDesktopDatabase> {
    const db=new PostgresDesktopDatabase(url);
    try {
      await db.transaction(async()=>{
        await db.client().query(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
        await db.client().query(`SET LOCAL search_path=${db.schema},pg_catalog`);
        await db.client().query(SCHEMA);
        const inventory=await db.client().query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[db.schema]);
        if(JSON.stringify(inventory.rows.map(r=>r.tablename))!==JSON.stringify([...DESKTOP_TABLES].sort()))throw new Error("Unsupported desktop target tables");
        const expected=desktopColumns();
        for(const table of DESKTOP_TABLES){
          const columns=await db.client().query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name",[db.schema,table]);
          const fields=expected[table].map(c=>({column_name:c.name,data_type:c.type==="TEXT"?"text":"bigint",is_nullable:c.notnull||c.pk?"NO":"YES"}));
          if(table==="desktop_releases")fields.push({column_name:"_sqlite_rowid",data_type:"bigint",is_nullable:"NO"});
          if(JSON.stringify(columns.rows)!==JSON.stringify(fields.sort((a,b)=>a.column_name<b.column_name?-1:1)))throw new Error("Unsupported desktop target columns");
        }


      });
      return db;
    } catch(error){await db.close();throw error;}
  }
  private client():PoolClient {
    const frame=this.context.getStore();
    if(!frame?.active)throw new Error("Desktop release query outside active transaction");
    return frame.client;
  }
  async transaction<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.context.getStore()?.active)return operation();
    const client=await this.pool.connect();const frame={client,active:true};let discard:Error|undefined;
    try {
      await client.query("BEGIN");
      // Serialize all per-tenant read/modify/write operations across processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[this.schema]);
      await client.query(`SET LOCAL search_path=pg_catalog,${this.schema}`);
      const result=await this.context.run(frame,operation);
      const commit=await client.query("COMMIT");
      if(commit.command!=="COMMIT")throw new Error("Desktop release transaction was not committed");
      return result;
    } catch(error) {
      try{await client.query("ROLLBACK");}catch{discard=new Error("Desktop release transaction connection failed");}
      throw error;
    } finally{frame.active=false;client.release(discard);}
  }
  prepare(sql:string) {
    const query=async(values:unknown[])=>{
      const result=await this.client().query(tenantSql(sql.replace(/\browid\b/g,"_sqlite_rowid")),values.map(v=>typeof v==="string"?encodeTenantText(v):v));
      for(const row of result.rows)for(const field of result.fields) {
        if(row[field.name]===null)continue;
        if(field.dataTypeID===20){
          const n=Number(row[field.name]);if(!Number.isSafeInteger(n))throw new Error("Desktop release integer exceeds supported range");row[field.name]=n;
        }else if(field.dataTypeID===25)row[field.name]=decodeTenantText(row[field.name]);
      }
      return result;
    };
    return {get:async(...values:unknown[])=>(await query(values)).rows[0],
      all:async(...values:unknown[])=>(await query(values)).rows,
      run:async(...values:unknown[])=>({changes:(await query(values)).rowCount??0})};
  }
  async exportSnapshot():Promise<DesktopReleaseSnapshot>{return this.transaction(async()=>{
    const columns=desktopColumns(),out={} as DesktopReleaseSnapshot;
    for(const table of DESKTOP_TABLES){const names=columns[table].map(c=>c.name);if(table==="desktop_releases")names.push("_sqlite_rowid");out[table]=await this.prepare('SELECT '+names.join(',')+' FROM '+table).all();}
    validateDesktopSnapshot(out);return out;
  });}
  async importSnapshot(snapshot:DesktopReleaseSnapshot){validateDesktopSnapshot(snapshot);return this.transaction(async()=>{
    const current=await this.exportSnapshot();if(desktopFingerprint(current)===desktopFingerprint(snapshot))return;
    if(Object.values(current).some(rows=>rows.length))throw new Error("Desktop migration target is not empty or differs");
    for(const table of DESKTOP_TABLES)for(const row of snapshot[table]){const names=Object.keys(row);await this.prepare('INSERT INTO '+table+' ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').run(...names.map(k=>row[k]));}
    await this.client().query("SELECT setval('desktop_releases__sqlite_rowid_seq',GREATEST(COALESCE((SELECT max(_sqlite_rowid) FROM desktop_releases),0),1),EXISTS(SELECT 1 FROM desktop_releases))");
    if(desktopFingerprint(await this.exportSnapshot())!==desktopFingerprint(snapshot))throw new Error("Desktop migration parity failed");
  });}
  close():Promise<void>{return this.pool.end();}
}
