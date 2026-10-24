import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// A schema belongs to exactly one tenant, including workspaces and run/message
// indexes which had tenant isolation through separate SQLite files.
export function sessionSchema(tenantId:string):string {
  if (!tenantId.trim()) throw new Error("Session storage requires a tenant");
  return "orvyn_sessions_"+createHash("sha256").update(tenantId).digest("hex").slice(0,40);
}

export const SESSION_TABLES=["workspaces","work_sessions","session_runs","session_messages"] as const;
const SCHEMA=`
CREATE TABLE IF NOT EXISTS workspaces (
 workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE,
 project_root TEXT NOT NULL, created_at BIGINT NOT NULL, known_files_json TEXT,
 logical_workspace_id TEXT, storage_type TEXT, status TEXT, branch TEXT, git_head TEXT,
 fingerprint_json TEXT, updated_at BIGINT, last_opened_at BIGINT
);
CREATE TABLE IF NOT EXISTS work_sessions (
 session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL, project_id TEXT, workspace_id TEXT, project_root TEXT,
 run_ids_json TEXT NOT NULL DEFAULT '[]', active_run_id TEXT,
 status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
 created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON work_sessions(tenant_id,updated_at);
CREATE TABLE IF NOT EXISTS session_runs(run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_messages (
 message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
 content TEXT NOT NULL, run_id TEXT, sequence BIGINT NOT NULL, mode TEXT,
 status TEXT NOT NULL DEFAULT 'complete', created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL, meta_json TEXT, UNIQUE(session_id,sequence)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id,sequence);
CREATE TABLE IF NOT EXISTS storage_version(version INTEGER PRIMARY KEY);
INSERT INTO storage_version(version) VALUES(1) ON CONFLICT DO NOTHING;
`;

// PostgreSQL text cannot contain NUL. Escaping every text binding makes the
// representation reversible, including literal backslashes and JSON strings.
// Fixed SQL literals in the shared session behavior contain neither character.
export const encodeSessionText=(value:string):string=>value.replace(/\\/g,"\\\\").replace(/\0/g,"\\0");
export const decodeSessionText=(value:string):string=>value.replace(/\\([\\0])/g,(_all,next)=>next==="0"?"\0":"\\");

export function sessionSql(sql:string):string {
  if (/INSERT OR REPLACE/i.test(sql)) {
    if (!/^\s*INSERT OR REPLACE INTO session_runs\s*\(run_id,\s*session_id\)/i.test(sql)) throw new Error("Unsupported session replacement statement");
    sql=sql.replace(/INSERT OR REPLACE/i,"INSERT")+" ON CONFLICT(run_id) DO UPDATE SET session_id=excluded.session_id";
  }
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
export class PostgresSessionDatabase {
  private readonly pool:Pool;
  private readonly context=new AsyncLocalStorage<Frame>();
  readonly schema:string;
  private constructor(url:string,readonly tenantId:string) {
    this.schema=sessionSchema(tenantId);
    this.pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,
      statement_timeout:10000,lock_timeout:5000,idleTimeoutMillis:30000,
      application_name:"orvyn-work-sessions"});
    this.pool.on("error",()=>console.warn("[work-sessions] idle PostgreSQL connection failed"));
  }
  static async connect(url:string,tenantId:string):Promise<PostgresSessionDatabase> {
    const db=new PostgresSessionDatabase(url,tenantId);
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
      const result=await this.client().query(sessionSql(sql),values.map(v=>typeof v==="string"?encodeSessionText(v):v));
      for(const row of result.rows)for(const field of result.fields) {
        if(row[field.name]===null)continue;
        if(field.dataTypeID===20){
          const n=Number(row[field.name]);if(!Number.isSafeInteger(n))throw new Error("Session integer exceeds supported range");row[field.name]=n;
        }else if(field.dataTypeID===25)row[field.name]=decodeSessionText(row[field.name]);
      }
      return result;
    };
    return {get:async(...values:unknown[])=>(await query(values)).rows[0],
      all:async(...values:unknown[])=>(await query(values)).rows,
      run:async(...values:unknown[])=>({changes:(await query(values)).rowCount??0})};
  }
  close():Promise<void>{return this.pool.end();}
}
