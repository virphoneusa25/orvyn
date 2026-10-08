import { AsyncLocalStorage } from "node:async_hooks";
import {SANDBOX_TABLES} from "./sandboxSchema";
import {sandboxColumns,validateSandboxSnapshot,sandboxFingerprint,type SandboxSnapshot} from "./SandboxSnapshot";
import { Pool, type PoolClient } from "pg";

import {POSTGRES_SANDBOX_SCHEMA as SCHEMA} from "./sandboxSchema";
import {encodeTenantText,decodeTenantText,tenantSql} from "../../persistence/PostgresTenantDatabase";
// PostgreSQL text cannot contain NUL. Escaping every text binding makes the
// representation reversible, including literal backslashes and JSON strings.
// Fixed SQL literals in the shared session behavior contain neither character.
type Frame={client:PoolClient;active:boolean};
export class PostgresSandboxDatabase {
  private readonly pool:Pool;
  private readonly context=new AsyncLocalStorage<Frame>();
  readonly schema:string;
  private constructor(url:string) {
    this.schema="orvyn_execution";
    this.pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,
      statement_timeout:10000,lock_timeout:5000,idleTimeoutMillis:30000,
      application_name:"orvyn-execution-registry"});
    this.pool.on("error",()=>console.warn("[execution-registry] idle PostgreSQL connection failed"));
  }
  static async connect(url:string):Promise<PostgresSandboxDatabase> {
    const db=new PostgresSandboxDatabase(url);
    try {
      await db.transaction(async()=>{
        await db.client().query(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
        await db.client().query(`SET LOCAL search_path=${db.schema},pg_catalog`);
        await db.client().query(SCHEMA);
        const inventory=await db.client().query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[db.schema]);
        if(JSON.stringify(inventory.rows.map(r=>r.tablename))!==JSON.stringify([...SANDBOX_TABLES].sort()))throw new Error("Unsupported sandbox target tables");
        const expected=sandboxColumns();
        for(const table of SANDBOX_TABLES){
          const columns=await db.client().query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name",[db.schema,table]);
          const fields=expected[table].map(c=>({column_name:c.name,data_type:c.type==="TEXT"?"text":"bigint",is_nullable:c.notnull||c.pk?"NO":"YES"}));
          
          if(JSON.stringify(columns.rows)!==JSON.stringify(fields.sort((a,b)=>a.column_name<b.column_name?-1:1)))throw new Error("Unsupported sandbox target columns");
        }


      });
      return db;
    } catch(error){await db.close();throw error;}
  }
  private client():PoolClient {
    const frame=this.context.getStore();
    if(!frame?.active)throw new Error("Sandbox query outside active transaction");
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
      if(commit.command!=="COMMIT")throw new Error("Sandbox transaction was not committed");
      return result;
    } catch(error) {
      try{await client.query("ROLLBACK");}catch{discard=new Error("Sandbox transaction connection failed");}
      throw error;
    } finally{frame.active=false;client.release(discard);}
  }
  prepare(sql:string) {
    const query=async(values:unknown[])=>{
      const result=await this.client().query(tenantSql(sql),values.map(v=>typeof v==="string"?encodeTenantText(v):v));
      for(const row of result.rows)for(const field of result.fields) {
        if(row[field.name]===null)continue;
        if(field.dataTypeID===20){
          const n=Number(row[field.name]);if(!Number.isSafeInteger(n))throw new Error("Sandbox integer exceeds supported range");row[field.name]=n;
        }else if(field.dataTypeID===1700){
          const n=Number(row[field.name]);if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER)throw new Error("Sandbox aggregate exceeds supported range");row[field.name]=n;
        }else if(field.dataTypeID===25)row[field.name]=decodeTenantText(row[field.name]);
      }
      return result;
    };
    return {get:async(...values:unknown[])=>(await query(values)).rows[0],
      all:async(...values:unknown[])=>(await query(values)).rows,
      run:async(...values:unknown[])=>({changes:(await query(values)).rowCount??0})};
  }
  async exportSnapshot():Promise<SandboxSnapshot>{return this.transaction(async()=>{
    const columns=sandboxColumns(),out={} as SandboxSnapshot;
    for(const table of SANDBOX_TABLES){const names=columns[table].map(c=>c.name);out[table]=await this.prepare('SELECT '+names.join(',')+' FROM '+table).all();}
    validateSandboxSnapshot(out);return out;
  });}
  async importSnapshot(snapshot:SandboxSnapshot){validateSandboxSnapshot(snapshot);return this.transaction(async()=>{
    const current=await this.exportSnapshot();if(sandboxFingerprint(current)===sandboxFingerprint(snapshot))return;
    if(Object.values(current).some(rows=>rows.length))throw new Error("Sandbox migration target is not empty or differs");
    for(const table of SANDBOX_TABLES)for(const row of snapshot[table]){const names=Object.keys(row);await this.prepare('INSERT INTO '+table+' ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').run(...names.map(k=>row[k]));}
    if(sandboxFingerprint(await this.exportSnapshot())!==sandboxFingerprint(snapshot))throw new Error("Sandbox migration parity failed");
  });}
  close():Promise<void>{return this.pool.end();}
}
