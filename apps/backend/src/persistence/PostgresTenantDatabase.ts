import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// A schema belongs to exactly one tenant, including workspaces and run/message
// indexes which had tenant isolation through separate SQLite files.
export function tenantDataSchema(tenantId:string):string {
  if (!tenantId.trim()) throw new Error("Session storage requires a tenant");
  return "orvyn_tenant_"+createHash("sha256").update(tenantId).digest("hex").slice(0,40);
}

import { TENANT_SCHEMA as SCHEMA } from "./PostgresTenantSchema";
export { TENANT_TABLES } from "./PostgresTenantSchema";

// PostgreSQL text cannot contain NUL. Escaping every text binding makes the
// representation reversible, including literal backslashes and JSON strings.
// Fixed SQL literals in the shared session behavior contain neither character.
export const encodeTenantText=(value:string):string=>value.replace(/\\/g,"\\\\").replace(/\0/g,"\\0");
export const decodeTenantText=(value:string):string=>value.replace(/\\([\\0])/g,(_all,next)=>next==="0"?"\0":"\\");

export function tenantSql(sql:string):string {
  if (/INSERT OR IGNORE/i.test(sql)) sql=sql.replace(/INSERT OR IGNORE/i,"INSERT")+" ON CONFLICT DO NOTHING";
  if (/INSERT OR REPLACE/i.test(sql)) throw new Error("Unsupported tenant replacement statement");
  sql=sql.replace(/ORDER BY rowid LIMIT 1000/i,"ORDER BY id LIMIT 1000");
  let quoted=false,index=0,out="";
  for(let i=0;i<sql.length;i++) {
    const ch=sql[i];
    if(ch==="'") {
      if(quoted&&sql[i+1]==="'"){out+="''";i++;continue;}
      quoted=!quoted;
    }
    out+=ch==="?"&&!quoted?`$${++index}`:ch;
  }
  return out;
}

type Frame={client:PoolClient;active:boolean};
export class PostgresTenantDatabase {
  private readonly pool:Pool;
  private readonly context=new AsyncLocalStorage<Frame>();
  readonly schema:string;
  private constructor(url:string,readonly tenantId:string) {
    this.schema=tenantDataSchema(tenantId);
    this.pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,
      statement_timeout:10000,lock_timeout:5000,idleTimeoutMillis:30000,
      application_name:"orvyn-tenant-data"});
    this.pool.on("error",()=>console.warn("[tenant-data] idle PostgreSQL connection failed"));
  }
  static async connect(url:string,tenantId:string):Promise<PostgresTenantDatabase> {
    const db=new PostgresTenantDatabase(url,tenantId);
    try {
      await db.transaction(async()=>{
        await db.client().query(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
        await db.client().query(`SET LOCAL search_path=${db.schema},pg_catalog`);
        await db.client().query(SCHEMA);
        const versions=await db.client().query("SELECT version FROM storage_version ORDER BY version");
        if(JSON.stringify(versions.rows)!==JSON.stringify([{version:1}]))throw new Error("Unsupported session storage version");
      });
      return db;
    } catch(error){await db.close();throw error;}
  }
  private client():PoolClient {
    const frame=this.context.getStore();
    if(!frame?.active)throw new Error("Session query outside active transaction");
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
      if(commit.command!=="COMMIT")throw new Error("Session transaction was not committed");
      return result;
    } catch(error) {
      try{await client.query("ROLLBACK");}catch{discard=new Error("Session transaction connection failed");}
      throw error;
    } finally{frame.active=false;client.release(discard);}
  }
  prepare(sql:string) {
    const query=async(values:unknown[])=>{
      const result=await this.client().query(tenantSql(sql),values.map(v=>typeof v==="string"?encodeTenantText(v):v));
      for(const row of result.rows)for(const field of result.fields) {
        if(row[field.name]===null)continue;
        if(field.dataTypeID===20){
          const n=Number(row[field.name]);if(!Number.isSafeInteger(n))throw new Error("Session integer exceeds supported range");row[field.name]=n;
        }else if(field.dataTypeID===25)row[field.name]=decodeTenantText(row[field.name]);
      }
      return result;
    };
    return {get:async(...values:unknown[])=>(await query(values)).rows[0],
      all:async(...values:unknown[])=>(await query(values)).rows,
      run:async(...values:unknown[])=>({changes:(await query(values)).rowCount??0})};
  }
  close():Promise<void>{return this.pool.end();}
}
