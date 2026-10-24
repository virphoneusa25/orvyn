import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {Pool} from "pg";
import {SandboxRegistry} from "./SandboxRegistry";
import {PostgresSandboxRegistry} from "./PostgresSandboxRegistry";
import {PostgresSandboxDatabase} from "./PostgresSandboxDatabase";
import {readSandboxSnapshot,sandboxFingerprint} from "./SandboxSnapshot";
import {credentialAllowed,decideRequest,pendingPolicyUpdate,requestNetworkAccess} from "./asyncPolicyRequests";
import {selectSandboxAsync,OPENSHELL_FLAG} from "./selection";
const base={id:"synthetic-sandbox",provider:"openshell" as const,organizationId:"synthetic-org",tenantId:"synthetic-tenant",userId:"synthetic-user",projectId:"synthetic-project",workspaceId:"synthetic-workspace",runId:"synthetic-run",policyTemplate:"code-basic",retention:"ephemeral" as const};
test("execution migration preserves every table, shared counters, identity and approval scope",{skip:process.env.ORVYN_EXECUTION_STORAGE_TEST!=="1"},async()=>{
 const url=process.env.ORVYN_PG_URL;assert.ok(url);assert.equal(new URL(url).pathname,"/execution_storage_test");
 const pool=new Pool({connectionString:url}),dir=fs.mkdtempSync(path.join(os.tmpdir(),"orvyn-execution-pg-")),file=path.join(dir,"execution.sqlite"),sqlite=new SandboxRegistry(file);
 let database:PostgresSandboxDatabase|undefined,first:PostgresSandboxRegistry|undefined,second:PostgresSandboxRegistry|undefined;
 try{
 sqlite.plan(base);sqlite.report(base.id,{state:"ready",provisionMs:17,lastError:"Unicode "+String.fromCharCode(937,0,92)});
 sqlite.setFlag("org",base.organizationId,OPENSHELL_FLAG,true,"staff:fixture");sqlite.audit("synthetic.audit","fixture",{sandboxId:base.id,detail:{note:"Unicode "+String.fromCharCode(937,0,92)}});
 sqlite.requestPolicy({sandboxId:base.id,runId:base.runId,organizationId:base.organizationId,template:"github",requestedBy:"model:fixture"});
 const snapshot=readSandboxSnapshot(file);database=await PostgresSandboxDatabase.connect(url);await database.importSnapshot(snapshot);await database.importSnapshot(snapshot);
 assert.equal(sandboxFingerprint(await database.exportSnapshot()),sandboxFingerprint(snapshot));
 first=await PostgresSandboxRegistry.connect(url);second=await PostgresSandboxRegistry.connect(url);
 assert.deepEqual(await first.get(base.id),{...sqlite.get(base.id),lastError:snapshot.execution_sandboxes[0].last_error});assert.deepEqual(await first.auditLog(),sqlite.auditLog());
 assert.equal(await first.report(base.id,{organizationId:"other-org"}),null);await assert.rejects(second.plan({...base,tenantId:"other-tenant"}),/immutable/);
 await Promise.all(Array.from({length:20},(_,i)=>(i%2?first!:second!).addExec(base.id,5)));assert.equal((await first.get(base.id))?.execCount,20);
 await Promise.all(Array.from({length:20},(_,i)=>(i%2?first!:second!).bump(base.id,"policyDenials")));assert.equal((await second.stats(3600000)).byProvider.openshell.policyDenials,20);
 const requests=await Promise.all(Array.from({length:8},(_,i)=>(i%2?first!:second!).requestPolicy({sandboxId:base.id,runId:base.runId,organizationId:base.organizationId,template:"deployment",requestedBy:"model:fixture"})));
 assert.equal(new Set(requests.map(r=>r.id)).size,1);
 const request=requests[0];assert.equal(await decideRequest(first,request.id,true,"user:other",{organizationId:"other-org"}),null);
 await assert.rejects(decideRequest(first,request.id,true,"model:fixture"),/person/);assert.deepEqual(await credentialAllowed(first,base.runId,"github"),{ok:false});
 await decideRequest(second,request.id,true,"user:fixture",{organizationId:base.organizationId});assert.equal((await pendingPolicyUpdate(first,base.runId))?.requestId,request.id);
 const granted=await credentialAllowed(first,base.runId,"github");assert.equal(granted.ok,true);if(granted.ok)assert.equal(granted.organizationId,base.organizationId);
 await first.markPolicyApplied(request.id,true);assert.equal((await second.policyRequest(request.id))?.status,"applied");
 const selected=await selectSandboxAsync({...base,planId:"pro"},first,{ORVYN_EXECUTION_PROVIDER:"auto",OPENSHELL_ENABLED:"true",OPENSHELL_ACCEPTANCE_PASSED:"true"});assert.equal(selected.provider,"openshell");
 await second.setFlag("project",base.projectId,OPENSHELL_FLAG,false,"user:fixture");assert.equal((await selectSandboxAsync({...base,planId:"pro"},first,{ORVYN_EXECUTION_PROVIDER:"auto",OPENSHELL_ENABLED:"true",OPENSHELL_ACCEPTANCE_PASSED:"true"})).provider,"docker");
 assert.equal((await requestNetworkAccess(first,{runId:base.runId,template:"research",hosts:["127.0.0.1"],planId:"pro"})).ok,false);
 const before=sandboxFingerprint(await database.exportSnapshot());await assert.rejects(database.importSnapshot(snapshot),/differs/);assert.equal(sandboxFingerprint(await database.exportSnapshot()),before);
 await pool.query("CREATE FUNCTION orvyn_execution.reject_synthetic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$; CREATE TRIGGER reject_synthetic BEFORE UPDATE ON orvyn_execution.execution_sandboxes FOR EACH ROW EXECUTE FUNCTION orvyn_execution.reject_synthetic()");
 await assert.rejects(first.report(base.id,{state:"failed"}),/synthetic rollback/);assert.equal((await second.get(base.id))?.state,"ready");
 await pool.query("DROP TRIGGER reject_synthetic ON orvyn_execution.execution_sandboxes; DROP FUNCTION orvyn_execution.reject_synthetic()");
 await first.close();first=undefined;first=await PostgresSandboxRegistry.connect(url);assert.equal((await first.forRun(base.runId))?.execMs,100);
 await first.report(base.id,{state:"stopped"});assert.deepEqual(await credentialAllowed(first,base.runId,"github"),{ok:false});assert.equal((await first.active()).length,0);
 sqlite.db.exec("CREATE TABLE unclassified(value TEXT)");assert.throws(()=>readSandboxSnapshot(file),/Unclassified/);
 }finally{sqlite.db.close();await first?.close();await second?.close();await database?.close();await pool.query("DROP SCHEMA IF EXISTS orvyn_execution CASCADE");await pool.end();fs.rmSync(dir,{recursive:true,force:true});}
});

test("execution PostgreSQL failure never creates or falls back to local SQLite",async()=>{
 const {spawnSync}=await import("node:child_process");const dir=fs.mkdtempSync(path.join(os.tmpdir(),"orvyn-execution-failclosed-"));
 try{
  const code=`(async()=>{const assert=require('node:assert/strict'),fs=require('node:fs');const {sandboxRegistry}=require(${JSON.stringify(path.join(__dirname,'AsyncSandboxRegistry'))});for(let i=0;i<2;i++)await assert.rejects(sandboxRegistry().active());assert.equal(fs.existsSync(${JSON.stringify(path.join(dir,'execution.sqlite'))}),false);})().catch(()=>process.exit(1))`;
  const result=spawnSync(process.execPath,["--no-warnings","-e",code],{env:{...process.env,ORVYN_DATA_DIR:dir,ORVYN_POSTGRES_MIRROR:"0",ORVYN_POSTGRES_PRIMARY_READS:"1",ORVYN_POSTGRES_PRIMARY_WRITES:"1",ORVYN_POSTGRES_READ_FALLBACK_SQLITE:"0",ORVYN_POSTGRES_EXECUTION:"1",DATABASE_URL:"postgresql://synthetic:synthetic@127.0.0.1:9/unavailable",ORVYN_PG_URL:"postgresql://synthetic:synthetic@127.0.0.1:9/unavailable"},timeout:15000});assert.equal(result.status,0,String(result.stderr));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
