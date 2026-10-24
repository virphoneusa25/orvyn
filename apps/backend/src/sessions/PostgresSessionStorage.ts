import { DatabaseSync } from "node:sqlite";
import { readSqliteSnapshotRows } from "../persistence/SqliteSnapshotRows";
import { existsSync, readFileSync } from "node:fs";
import { PostgresSessionDatabase, SESSION_TABLES } from "./PostgresSessionDatabase";

type TableSnapshot={columns:string[];rows:Record<string,unknown>[]};
export type SessionSnapshot=Record<typeof SESSION_TABLES[number],TableSnapshot>;
const identifier=(name:string):string=>'"'+name.replace(/"/g,'""')+'"';
const canonical=(table:TableSnapshot):string=>JSON.stringify(table.rows.map(row=>
 Object.fromEntries(table.columns.slice().sort().map(column=>[column,row[column]]))).map(row=>JSON.stringify(row)).sort());

export function readSessionSnapshot(file:string,tenantId:string):SessionSnapshot {
 if(!existsSync(file)||readFileSync(file).subarray(0,16).toString('latin1')!=="SQLite format 3\0")throw new Error("Missing or invalid session database");
 const db=new DatabaseSync(file,{readOnly:true});
 try {
  db.exec("BEGIN");
  const integrity=db.prepare("PRAGMA integrity_check").get();
  if(!integrity||Object.values(integrity)[0]!=="ok")throw new Error("Session SQLite integrity check failed");
  const snapshot={} as SessionSnapshot;
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  if(tables.length!==SESSION_TABLES.length||tables.some(row=>!SESSION_TABLES.includes(row.name as typeof SESSION_TABLES[number])))throw new Error("Unexpected session database tables");
  for(const table of SESSION_TABLES) {
   const info=db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as {name:string;type:string}[];
   const columns=info.map(row=>row.name);
   if(!columns.length)throw new Error("Incomplete session database schema");
   const rows=readSqliteSnapshotRows(db,table,info);
   for(const row of rows)for(const value of Object.values(row))if(typeof value==="bigint"||typeof value==="number"&&!Number.isSafeInteger(value))throw new Error("Session value exceeds supported range");
   snapshot[table]={columns,rows};
  }
  if(snapshot.work_sessions.rows.some(row=>row.tenant_id!==tenantId))throw new Error("Session database contains another tenant");
  const sessions=new Set(snapshot.work_sessions.rows.map(row=>row.session_id));
  if([...snapshot.session_runs.rows,...snapshot.session_messages.rows].some(row=>!sessions.has(row.session_id)))throw new Error("Session database contains orphan run or message records");
  db.exec("COMMIT");return snapshot;
 }finally{db.close();}
}

/** Explicit, atomic import; never replaces divergent existing PostgreSQL data. */
export class PostgresSessionStorage {
 private constructor(private readonly database:PostgresSessionDatabase){}
 static async connect(url:string,tenantId:string):Promise<PostgresSessionStorage>{return new PostgresSessionStorage(await PostgresSessionDatabase.connect(url,tenantId));}
 private async snapshot():Promise<SessionSnapshot> {
  const out={} as SessionSnapshot;
  for(const table of SESSION_TABLES) {
   const columns=await this.database.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position").all(this.database.schema,table);
   out[table]={columns:columns.map(row=>row.column_name),rows:await this.database.prepare(`SELECT * FROM ${identifier(table)}`).all()};
  }
  return out;
 }
 exportSnapshot():Promise<SessionSnapshot>{return this.database.transaction(()=>this.snapshot());}
 async importSqlite(file:string):Promise<{tables:number;records:number;alreadyImported:boolean}> {
  const source=readSessionSnapshot(file,this.database.tenantId);
  return this.database.transaction(async()=>{
   const before=await this.snapshot();
   for(const table of SESSION_TABLES)if(JSON.stringify(before[table].columns.slice().sort())!==JSON.stringify(source[table].columns.slice().sort()))throw new Error("Session migration column mismatch");
   const records=SESSION_TABLES.reduce((sum,table)=>sum+source[table].rows.length,0);
   const alreadyImported=SESSION_TABLES.every(table=>canonical(source[table])===canonical(before[table]));
   if(alreadyImported)return{tables:SESSION_TABLES.length,records,alreadyImported:true};
   if(SESSION_TABLES.some(table=>before[table].rows.length))throw new Error("PostgreSQL session data differs from migration source");
   for(const table of SESSION_TABLES) {
    const {columns,rows}=source[table];
    const insert=this.database.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of rows)await insert.run(...columns.map(column=>row[column]));
   }
   const after=await this.snapshot();
   if(!SESSION_TABLES.every(table=>canonical(source[table])===canonical(after[table])))throw new Error("Session migration content parity failed");
   return{tables:SESSION_TABLES.length,records,alreadyImported:false};
  });
 }
 close():Promise<void>{return this.database.close();}
}
