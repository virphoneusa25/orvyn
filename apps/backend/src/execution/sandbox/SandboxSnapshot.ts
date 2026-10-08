import {DatabaseSync} from "node:sqlite";
import {readSqliteSnapshotRows} from "../../persistence/SqliteSnapshotRows";
import {SQLITE_SANDBOX_SCHEMA,SANDBOX_TABLES} from "./sandboxSchema";
type Column={name:string;type:string;notnull:number;pk:number};
export type SandboxSnapshot=Record<typeof SANDBOX_TABLES[number],Record<string,unknown>[]>;
export function sandboxColumns():Record<string,Column[]>{
 const db=new DatabaseSync(":memory:");try{db.exec(SQLITE_SANDBOX_SCHEMA);return Object.fromEntries(SANDBOX_TABLES.map(t=>[t,db.prepare('PRAGMA table_info('+t+')').all().map(c=>({name:String(c.name),type:String(c.type),notnull:Number(c.notnull),pk:Number(c.pk)}))]));}finally{db.close();}
}
export function validateSandboxSnapshot(value:unknown):asserts value is SandboxSnapshot{
 if(!value||typeof value!=="object"||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...SANDBOX_TABLES].sort()))throw new Error("Unknown sandbox snapshot tables");
 const columns=sandboxColumns();
 for(const table of SANDBOX_TABLES){const rows=(value as SandboxSnapshot)[table];if(!Array.isArray(rows))throw new Error("Invalid sandbox snapshot rows");
 const expected=columns[table];const names=expected.map(c=>c.name);
 for(const row of rows){if(!row||JSON.stringify(Object.keys(row).sort())!==JSON.stringify([...names].sort()))throw new Error("Unknown sandbox snapshot columns");
 for(const c of expected){const v=row[c.name];if(v===null){if(c.notnull||c.pk)throw new Error("Null required desktop value");continue;}if(c.type==="TEXT"?typeof v!=="string":!Number.isSafeInteger(v))throw new Error("Invalid sandbox snapshot value");}
 
 }}
}
export function readSandboxSnapshot(file:string):SandboxSnapshot{
 const db=new DatabaseSync(file,{readOnly:true});try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));if(JSON.stringify(tables)!==JSON.stringify([...SANDBOX_TABLES].sort()))throw new Error("Unclassified sandbox snapshot table");
 const expected=sandboxColumns(),out={} as SandboxSnapshot;
 for(const table of SANDBOX_TABLES){const actual=db.prepare('PRAGMA table_info('+table+')').all().map(c=>({name:String(c.name),type:String(c.type),notnull:Number(c.notnull),pk:Number(c.pk)}));if(JSON.stringify(actual)!==JSON.stringify(expected[table]))throw new Error("Unsupported sandbox snapshot schema");
 const columns=expected[table].map(c=>({name:c.name,type:c.type}));
 out[table]=readSqliteSnapshotRows(db,table,columns);}
 validateSandboxSnapshot(out);return out;
 }finally{db.close();}
}
export const sandboxFingerprint=(snapshot:SandboxSnapshot)=>JSON.stringify(Object.entries(snapshot).sort(([a],[b])=>a.localeCompare(b)).map(([table,rows])=>[table,rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort()]));
