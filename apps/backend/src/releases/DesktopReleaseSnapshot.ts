import {DatabaseSync} from "node:sqlite";
import {readSqliteSnapshotRows} from "../persistence/SqliteSnapshotRows";
import {SQLITE_DESKTOP_SCHEMA,DESKTOP_TABLES} from "./desktopReleaseSchema";
type Column={name:string;type:string;notnull:number;pk:number};
export type DesktopReleaseSnapshot=Record<typeof DESKTOP_TABLES[number],Record<string,unknown>[]>;
export function desktopColumns():Record<string,Column[]>{
 const db=new DatabaseSync(":memory:");try{db.exec(SQLITE_DESKTOP_SCHEMA);return Object.fromEntries(DESKTOP_TABLES.map(t=>[t,db.prepare('PRAGMA table_info('+t+')').all().map(c=>({name:String(c.name),type:String(c.type),notnull:Number(c.notnull),pk:Number(c.pk)}))]));}finally{db.close();}
}
export function validateDesktopSnapshot(value:unknown):asserts value is DesktopReleaseSnapshot{
 if(!value||typeof value!=="object"||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...DESKTOP_TABLES].sort()))throw new Error("Unknown desktop snapshot tables");
 const columns=desktopColumns();
 for(const table of DESKTOP_TABLES){const rows=(value as DesktopReleaseSnapshot)[table];if(!Array.isArray(rows))throw new Error("Invalid desktop snapshot rows");
 const expected=columns[table];const names=expected.map(c=>c.name);if(table==="desktop_releases")names.push("_sqlite_rowid");
 for(const row of rows){if(!row||JSON.stringify(Object.keys(row).sort())!==JSON.stringify([...names].sort()))throw new Error("Unknown desktop snapshot columns");
 for(const c of expected){const v=row[c.name];if(v===null){if(c.notnull||c.pk)throw new Error("Null required desktop value");continue;}if(c.type==="TEXT"?typeof v!=="string":!Number.isSafeInteger(v))throw new Error("Invalid desktop snapshot value");}
 if(table==="desktop_releases"&&(!Number.isSafeInteger(row._sqlite_rowid)||Number(row._sqlite_rowid)<1))throw new Error("Invalid source row ordering");
 }}
}
export function readDesktopSnapshot(file:string):DesktopReleaseSnapshot{
 const db=new DatabaseSync(file,{readOnly:true});try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));if(JSON.stringify(tables)!==JSON.stringify([...DESKTOP_TABLES].sort()))throw new Error("Unclassified desktop snapshot table");
 const expected=desktopColumns(),out={} as DesktopReleaseSnapshot;
 for(const table of DESKTOP_TABLES){const actual=db.prepare('PRAGMA table_info('+table+')').all().map(c=>({name:String(c.name),type:String(c.type),notnull:Number(c.notnull),pk:Number(c.pk)}));if(JSON.stringify(actual)!==JSON.stringify(expected[table]))throw new Error("Unsupported desktop snapshot schema");
 const columns=expected[table].map(c=>({name:c.name,type:c.type}));if(table==="desktop_releases")columns.unshift({name:"rowid",type:"INTEGER"});
 out[table]=readSqliteSnapshotRows(db,table,columns).map(row=>{if(table!=="desktop_releases")return row;const {rowid,...rest}=row;return {...rest,_sqlite_rowid:rowid};});}
 validateDesktopSnapshot(out);return out;
 }finally{db.close();}
}
export const desktopFingerprint=(snapshot:DesktopReleaseSnapshot)=>JSON.stringify(Object.entries(snapshot).sort(([a],[b])=>a.localeCompare(b)).map(([table,rows])=>[table,rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort()]));
