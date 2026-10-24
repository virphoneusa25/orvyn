import test from "node:test";
import assert from "node:assert/strict";
import { storageConfiguration } from "./storageConfiguration";
import { createPostgresRuntime, type PostgresRuntime } from "./PostgresRuntime";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("primary selection rejects partial switches, mirrors and SQLite fallback",()=>{
 const primary={ORVYN_POSTGRES_PRIMARY_READS:"1",ORVYN_POSTGRES_PRIMARY_WRITES:"1",ORVYN_POSTGRES_READ_FALLBACK_SQLITE:"0",ORVYN_PG_URL:"postgres://fixture"};
 assert.deepEqual(storageConfiguration({}),{mode:"sqlite"});
 assert.deepEqual(storageConfiguration(primary),{mode:"postgres",url:"postgres://fixture"});
 assert.throws(()=>storageConfiguration({...primary,ORVYN_POSTGRES_PRIMARY_WRITES:"0"}),/switch together/);
 assert.throws(()=>storageConfiguration({...primary,ORVYN_POSTGRES_MIRROR:"1"}),/mirror/);
 assert.throws(()=>storageConfiguration({...primary,ORVYN_POSTGRES_READ_FALLBACK_SQLITE:"1"}),/fallback/);
 assert.throws(()=>storageConfiguration({...primary,ORVYN_PG_URL:""}),/requires/);
});
test("concurrent primary loads share one owner and preserve initialization failure",async()=>{
 let loads=0;const failure=new Error("unavailable");
 const load=createPostgresRuntime(async()=>{loads++;throw failure;});
 await Promise.all([assert.rejects(load(),e=>e===failure),assert.rejects(load(),e=>e===failure)]);assert.equal(loads,1);
 const owner={} as PostgresRuntime;const ready=createPostgresRuntime(async()=>owner);assert.equal(await ready(),await ready());
});
test("real PostgreSQL: actual default boundaries use one primary owner without SQLite databases",{skip:process.env.ORVYN_PRIMARY_RUNTIME_TEST!=="1"||!process.env.ORVYN_PG_URL},()=>{
 const dir=mkdtempSync(join(tmpdir(),"primary-runtime-"));
 try{
 const script=`(async()=>{
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 const {accountAuth,staffStore,onboardingStore}=require('./auth/AsyncAccountStores');
 const {creditLedger,paymentStore}=require('./billing/AsyncFinancialStores');
 const {adminService}=require('./admin/AsyncAdminService');
 const {openTenantStorage,openSessionStorage,postgresRuntime}=require('./persistence/PostgresRuntime');
 const owner=await postgresRuntime();const account=await accountAuth.register(require('node:crypto').randomUUID()+'@example.invalid','primary-runtime-password');const id=account.organization.tenantId;
 await creditLedger.ensureAccount(id);await paymentStore().saveCustomer(id,'cus_fixture_'+id,account.user.email);
 await staffStore().setStaff(account.user.email,'support','fixture');await onboardingStore().ensure(account.user.id,'fixture');
 assert.equal(await staffStore().roleOf(account.user.id),'support');assert.equal((await adminService().owner(id)).email,account.user.email);
 const store=await openTenantStorage(id),sessions=await openSessionStorage(id);
 try{await store.setSetting('fixture','primary');assert.equal(await store.getSetting('fixture'),'primary');const session=await sessions.create({title:'primary',userId:account.user.id});assert.equal((await sessions.get(session.sessionId)).title,'primary');}
 finally{await store.close();await sessions.close();}
 assert.equal(fs.readdirSync(process.env.ORVYN_DATA_DIR).some(name=>/\\.(db|sqlite)$/.test(name)),false);
 await owner.close();
 })().catch(error=>{console.error(error);process.exitCode=1});`;
 execFileSync(process.execPath,["-e",script],{cwd:join(__dirname,".."),env:{...process.env,ORVYN_DATA_DIR:dir,ORVYN_POSTGRES_PRIMARY_READS:"1",ORVYN_POSTGRES_PRIMARY_WRITES:"1",ORVYN_POSTGRES_READ_FALLBACK_SQLITE:"0",ORVYN_POSTGRES_MIRROR:"0"},stdio:"pipe",timeout:60000});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
