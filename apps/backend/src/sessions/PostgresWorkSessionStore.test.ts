import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { WorkSessionStore } from "./WorkSessionStore";
import { PostgresWorkSessionStore } from "./PostgresWorkSessionStore";
import { PostgresSessionStorage, readSessionSnapshot } from "./PostgresSessionStorage";
import { decodeSessionText, encodeSessionText, sessionSchema, sessionSql } from "./PostgresSessionDatabase";

const integration=process.env.ORVYN_SESSION_RUNTIME_TEST==="1"&&Boolean(process.env.ORVYN_PG_URL);
const url=process.env.ORVYN_PG_URL!;
const temp=()=>mkdtempSync(join(tmpdir(),"orvyn-pg-sessions-"));
async function cleanup(tenants:string[]):Promise<void>{
 const pool=new Pool({connectionString:url});
 try{for(const tenant of tenants)await pool.query(`DROP SCHEMA IF EXISTS ${sessionSchema(tenant)} CASCADE`);}finally{await pool.end();}
}
test("session SQL and persisted text preserve question marks, NUL and literal escape sequences",()=>{
 assert.equal(sessionSql("SELECT '?' WHERE content=? AND title='it''s?'"),"SELECT '?' WHERE content=$1 AND title='it''s?'");
 assert.match(sessionSql("INSERT OR REPLACE INTO session_runs (run_id, session_id) VALUES (?, ?)"),/ON CONFLICT\(run_id\)/);
 assert.throws(()=>sessionSql("INSERT OR REPLACE INTO unknown (id) VALUES (?)"),/Unsupported/);
 for(const value of ["","\0","\\0","\\\0","hello\0world","C:\\Users\\name\\0","Ω\n日本語","{\"text\":\"\\u0000\"}"])
  assert.equal(decodeSessionText(encodeSessionText(value)),value);
 assert.notEqual(sessionSchema("Tenant"),sessionSchema("tenant"));
 assert.match(sessionSchema("untrusted';DROP SCHEMA public;--"),/^orvyn_sessions_[a-f0-9]{40}$/);
});
test("session migration rejects missing databases and another tenant without creating files",()=>{
 const dir=temp();const sqlite=new WorkSessionStore('owner',dir);
 try{
  sqlite.create({title:'private'});
  assert.throws(()=>readSessionSnapshot(join(dir,'missing.db'),'owner'),/Missing or invalid/);
  assert.throws(()=>readSessionSnapshot(join(dir,'owner-sessions.db'),'other'),/another tenant/);
 }finally{sqlite.close();rmSync(dir,{recursive:true,force:true});}
});
test("real Postgres: complete SQLite sessions migrate with content parity, restart and safe repeat import",{skip:!integration},async()=>{
 const tenant=randomUUID(),dir=temp(),sqlite=new WorkSessionStore(tenant,dir);
 const session=sqlite.create({title:'A\0title\\0',userId:'user',projectRoot:'C:\\project\\0'});
 sqlite.attachRun(session.sessionId,'run-one');sqlite.attachRun(session.sessionId,'run-two');
 sqlite.appendMessage(session.sessionId,{messageId:'user-one',role:'user',content:'content\0with\\0escape',meta:{nested:['\0','\\0']}});
 sqlite.appendMessage(session.sessionId,{messageId:'assistant-one',role:'assistant',content:'answer',runId:'run-one'});
 sqlite.rememberFiles(session.workspaceId!,['src/a.ts','../escape']);sqlite.update(session.sessionId,{pinned:true,status:'idle'});
 const expected={session:sqlite.get(session.sessionId),messages:sqlite.messages(session.sessionId),workspace:sqlite.getWorkspace(session.workspaceId!)};
 sqlite.close();let migration:PostgresSessionStorage|undefined,pg:PostgresWorkSessionStore|undefined;
 try{
  migration=await PostgresSessionStorage.connect(url,tenant);
  const first=await migration.importSqlite(join(dir,`${tenant}-sessions.db`));assert.equal(first.alreadyImported,false);assert.equal(first.tables,4);
  assert.equal((await migration.importSqlite(join(dir,`${tenant}-sessions.db`))).alreadyImported,true);
  await migration.close();migration=undefined;
  pg=await PostgresWorkSessionStore.connect(url,tenant,dir);
  assert.deepEqual(await pg.get(session.sessionId),expected.session);
  assert.deepEqual(await pg.messages(session.sessionId),expected.messages);
  assert.deepEqual(await pg.getWorkspace(session.workspaceId!),expected.workspace);
  assert.equal((await pg.sessionOfRun('run-two'))?.sessionId,session.sessionId);
  await pg.update(session.sessionId,{title:'new authoritative value'});
  migration=await PostgresSessionStorage.connect(url,tenant);
  await assert.rejects(migration.importSqlite(join(dir,`${tenant}-sessions.db`)),/differs/);
  assert.equal((await pg.get(session.sessionId))?.title,'new authoritative value');
 }finally{await pg?.close();await migration?.close();await cleanup([tenant]);rmSync(dir,{recursive:true,force:true});}
});
test("real Postgres: concurrent message sequence, idempotent retries and run/workspace updates across processes",{skip:!integration},async()=>{
 const tenant=randomUUID(),dir=temp(),a=await PostgresWorkSessionStore.connect(url,tenant,dir),b=await PostgresWorkSessionStore.connect(url,tenant,dir);
 try{
  const session=await a.create({title:'Concurrent'});
  const messages=await Promise.all(Array.from({length:16},(_,i)=>(i%2?a:b).appendMessage(session.sessionId,{messageId:'msg-'+i,role:'user',content:'message '+i})));
  assert.equal(messages.filter(Boolean).length,16);
  assert.deepEqual((await a.messages(session.sessionId)).map(m=>m.sequence),Array.from({length:16},(_,i)=>i+1));
  await Promise.all([a.appendMessage(session.sessionId,{messageId:'repeat',role:'assistant',content:'one'}),b.appendMessage(session.sessionId,{messageId:'repeat',role:'assistant',content:'two'})]);
  assert.equal((await a.messages(session.sessionId)).length,17);
  await Promise.all([a.attachRun(session.sessionId,'a'),b.attachRun(session.sessionId,'b')]);
  assert.deepEqual((await a.get(session.sessionId))!.runIds.slice().sort(),['a','b']);
  const spaces=await Promise.all([a.workspaceFor('C:\\stable'),b.workspaceFor('c:/stable/')]);
  assert.equal(spaces[0].workspaceId,spaces[1].workspaceId);assert.equal(spaces.filter(s=>s.created).length,1);
  await Promise.all([a.rememberFiles(spaces[0].workspaceId,['one.ts']),b.rememberFiles(spaces[0].workspaceId,['two.ts'])]);
  assert.deepEqual((await a.knownFiles(spaces[0].workspaceId)).sort(),['one.ts','two.ts']);
 }finally{await a.close();await b.close();await cleanup([tenant]);rmSync(dir,{recursive:true,force:true});}
});
test("real Postgres: failed message deletion rolls back session and run deletion",{skip:!integration},async()=>{
 const tenant=randomUUID(),dir=temp(),store=await PostgresWorkSessionStore.connect(url,tenant,dir),audit=new Pool({connectionString:url});
 try{
  const session=await store.create({title:'Keep on rollback'});await store.attachRun(session.sessionId,'held-run');
  await store.appendMessage(session.sessionId,{role:'user',content:'keep'});
  const schema=sessionSchema(tenant);
  await audit.query(`CREATE FUNCTION ${schema}.reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced delete failure'; END; $$; CREATE TRIGGER reject_delete BEFORE DELETE ON ${schema}.session_messages FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_delete()`);
  await assert.rejects(store.delete(session.sessionId),/forced delete failure/);
  assert.ok(await store.get(session.sessionId));assert.ok(await store.sessionOfRun('held-run'));assert.equal((await store.messages(session.sessionId)).length,1);
  await audit.query(`DROP TRIGGER reject_delete ON ${schema}.session_messages; DROP FUNCTION ${schema}.reject_delete()`);
  assert.equal(await store.delete(session.sessionId),true);assert.equal(await store.sessionOfRun('held-run'),undefined);assert.deepEqual(await store.messages(session.sessionId),[]);
 }finally{await store.close();await audit.end();await cleanup([tenant]);rmSync(dir,{recursive:true,force:true});}
});
test("real Postgres: failed migration insert rolls back every imported session table",{skip:!integration},async()=>{
 const tenant=randomUUID(),dir=temp(),sqlite=new WorkSessionStore(tenant,dir);
 const session=sqlite.create({title:'Atomic import',projectRoot:'/synthetic/workspace'});sqlite.attachRun(session.sessionId,'migration-run');sqlite.appendMessage(session.sessionId,{role:'user',content:'migration message'});sqlite.close();
 const migration=await PostgresSessionStorage.connect(url,tenant),audit=new Pool({connectionString:url});
 try{
  const schema=sessionSchema(tenant);
  await audit.query(`CREATE FUNCTION ${schema}.reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced import failure'; END; $$; CREATE TRIGGER reject_import BEFORE INSERT ON ${schema}.session_messages FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_import()`);
  await assert.rejects(migration.importSqlite(join(dir,`${tenant}-sessions.db`)),/forced import failure/);
  for(const table of Object.values(await migration.exportSnapshot()))assert.equal(table.rows.length,0);
  await audit.query(`DROP TRIGGER reject_import ON ${schema}.session_messages; DROP FUNCTION ${schema}.reject_import()`);
  assert.equal((await migration.importSqlite(join(dir,`${tenant}-sessions.db`))).alreadyImported,false);
 }finally{await migration.close();await audit.end();await cleanup([tenant]);rmSync(dir,{recursive:true,force:true});}
});
test("real Postgres: tenant-scoped run, message and workspace identifiers never cross tenants",{skip:!integration},async()=>{
 const tenants=[randomUUID(),randomUUID()],dir=temp(),a=await PostgresWorkSessionStore.connect(url,tenants[0],dir),b=await PostgresWorkSessionStore.connect(url,tenants[1],dir);
 try{
  const session=await a.create({title:'Owner'});await a.attachRun(session.sessionId,'shared-run');await a.appendMessage(session.sessionId,{messageId:'shared-msg',role:'user',content:'private'});
  assert.equal(await b.get(session.sessionId),undefined);assert.equal(await b.sessionOfRun('shared-run'),undefined);assert.equal(await b.getMessage('shared-msg'),undefined);assert.deepEqual(await b.messages(session.sessionId),[]);
  const other=await b.create({title:'Other'});await b.attachRun(other.sessionId,'shared-run');await b.appendMessage(other.sessionId,{messageId:'shared-msg',role:'user',content:'other'});
  assert.equal((await a.getMessage('shared-msg'))?.content,'private');assert.equal(await b.delete(session.sessionId),false);
  const workspace=await a.workspaceFor('/shared/path');assert.equal(await b.getWorkspace(workspace.workspaceId),undefined);
  assert.equal((await b.get(other.sessionId))?.title,'Other');
 }finally{await a.close();await b.close();await cleanup(tenants);rmSync(dir,{recursive:true,force:true});}
});
