import { DatabaseSync } from "node:sqlite";
import { readSqliteSnapshotRows } from "./SqliteSnapshotRows";
import { existsSync, readFileSync } from "node:fs";
import { PostgresTenantDatabase, TENANT_TABLES } from "./PostgresTenantDatabase";

type TableSnapshot={columns:string[];rows:Record<string,unknown>[]};
export type TenantDataSnapshot=Record<typeof TENANT_TABLES[number],TableSnapshot>;
const identifier=(name:string):string=>'"'+name.replace(/"/g,'""')+'"';
const canonical=(table:TableSnapshot):string=>JSON.stringify(table.rows.map(row=>
 Object.fromEntries(table.columns.slice().sort().map(column=>[column,row[column]]))).map(row=>JSON.stringify(row)).sort());

export function readTenantDataSnapshot(file:string,tenantId:string):TenantDataSnapshot {
 if(!existsSync(file)||readFileSync(file).subarray(0,16).toString('latin1')!=="SQLite format 3\0")throw new Error("Missing or invalid tenant database");
 const db=new DatabaseSync(file,{readOnly:true});
 try {
  db.exec("BEGIN");
  const integrity=db.prepare("PRAGMA integrity_check").get();
  if(!integrity||Object.values(integrity)[0]!=="ok")throw new Error("Tenant SQLite integrity check failed");
  const snapshot={} as TenantDataSnapshot;
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  if(tables.length!==TENANT_TABLES.length||tables.some(row=>!TENANT_TABLES.includes(row.name as typeof TENANT_TABLES[number])))throw new Error("Unexpected tenant database tables");
  for(const table of TENANT_TABLES) {
   const info=db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as {name:string;type:string}[];
   const columns=info.map(row=>row.name);
   if(!columns.length)throw new Error("Incomplete tenant database schema");
   const rows=readSqliteSnapshotRows(db,table,info);
   for(const row of rows)for(const value of Object.values(row))if(typeof value==="bigint"||typeof value==="number"&&!Number.isSafeInteger(value))throw new Error("Tenant value exceeds supported range");
   snapshot[table]={columns,rows};
  }
  if(snapshot.artifacts.rows.some(row=>row.tenant_id!==null&&row.tenant_id!==undefined&&row.tenant_id!==tenantId))throw new Error("Tenant database contains foreign artifact ownership");
  db.exec("COMMIT");return snapshot;
 }finally{db.close();}
}

/** Explicit, atomic import; never replaces divergent existing PostgreSQL data. */
export class PostgresTenantStorage {
 private constructor(private readonly database:PostgresTenantDatabase){}
 static async connect(url:string,tenantId:string):Promise<PostgresTenantStorage>{return new PostgresTenantStorage(await PostgresTenantDatabase.connect(url,tenantId));}
 private async snapshot():Promise<TenantDataSnapshot> {
  const out={} as TenantDataSnapshot;
  for(const table of TENANT_TABLES) {
   const columns=await this.database.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position").all(this.database.schema,table);
   out[table]={columns:columns.map(row=>row.column_name),rows:await this.database.prepare(`SELECT * FROM ${identifier(table)}`).all()};
  }
  return out;
 }
 exportSnapshot():Promise<TenantDataSnapshot>{return this.database.transaction(()=>this.snapshot());}
 async importSqlite(file:string):Promise<{tables:number;records:number;alreadyImported:boolean}> {
  const source=readTenantDataSnapshot(file,this.database.tenantId);
  return this.database.transaction(async()=>{
   const before=await this.snapshot();
   for(const table of TENANT_TABLES)if(JSON.stringify(before[table].columns.slice().sort())!==JSON.stringify(source[table].columns.slice().sort()))throw new Error("Tenant migration column mismatch");
   const records=TENANT_TABLES.reduce((sum,table)=>sum+source[table].rows.length,0);
   const alreadyImported=TENANT_TABLES.every(table=>canonical(source[table])===canonical(before[table]));
   if(alreadyImported)return{tables:TENANT_TABLES.length,records,alreadyImported:true};
   if(TENANT_TABLES.some(table=>before[table].rows.length))throw new Error("PostgreSQL tenant data differs from migration source");
   for(const table of TENANT_TABLES) {
    const {columns,rows}=source[table];
    const insert=this.database.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of rows)await insert.run(...columns.map(column=>row[column]));
   }
   const after=await this.snapshot();
   if(!TENANT_TABLES.every(table=>canonical(source[table])===canonical(after[table])))throw new Error("Tenant migration content parity failed");
   return{tables:TENANT_TABLES.length,records,alreadyImported:false};
  });
 }
 close():Promise<void>{return this.database.close();}
}
