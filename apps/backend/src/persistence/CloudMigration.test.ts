import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readdirSync,copyFileSync,readFileSync,writeFileSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {StaffStore} from "../admin/staffStore";
import {OnboardingStore} from "../onboarding/OnboardingStore";
import {CreditLedger} from "../billing/CreditLedger";
import {StripeStore} from "../billing/stripe";
import {LocalStore} from "./LocalStore";
import {WorkSessionStore} from "../sessions/WorkSessionStore";
import {Pool} from "pg";
const {preflight,migrate}=require("../../scripts/migrate-cloud-postgres.cjs");
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"cloud-migration-")),data=join(dir,"data"),source=join(dir,"snapshot");mkdirSync(data);mkdirSync(join(source,"sqlite"),{recursive:true});
 const previous=process.env.ORVYN_DATA_DIR;process.env.ORVYN_DATA_DIR=data;
 try{
  const {AuthService,authService}=require("../auth/AuthService");try{authService.close();}catch{/* singleton already closed by the previous fixture */}
  const auth=new AuthService(data),account=auth.register(randomUUID()+"@example.invalid","migration-password-123");const id=account.organization.tenantId;
  const staff=new StaffStore(data);staff.setStaff(account.user.email,"support","fixture");staff.db.close();new OnboardingStore(data).close();auth.close();
  const ledger=new CreditLedger(join(data,"billing.sqlite"));ledger.ensureAccount(id);ledger.close();const stripe=new StripeStore(join(data,"payments.sqlite"));stripe.saveCustomer(id,"cus_fixture",account.user.email);stripe.db.close();
  const store=new LocalStore(id,data);store.setSetting("fixture","Unicode Ω NUL\0 and \\0");store.close();
  const sessions=new WorkSessionStore(id,data);const session=sessions.create({title:"Migration",userId:account.user.id});sessions.appendMessage(session.sessionId,{role:"user",content:"Keep Unicode Ω\0"});sessions.close();
  const databases=readdirSync(data).filter(name=>/\.(db|sqlite)$/.test(name)).map(name=>{const file=join(source,"sqlite",name);copyFileSync(join(data,name),file);return {path:name,bytes:statSync(file).size,sha256:createHash("sha256").update(readFileSync(file)).digest("hex")};});
  writeFileSync(join(source,"manifest.json"),JSON.stringify({createdAt:new Date().toISOString(),databases}));return {dir,source,id};
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
 finally{if(previous===undefined)delete process.env.ORVYN_DATA_DIR;else process.env.ORVYN_DATA_DIR=previous;}
}
test("cloud migration preflight verifies every core family without connecting and rejects tampered/omitted sources",async()=>{
 const f=fixture();try{
  const plan=preflight(f.source);assert.equal(plan.summary.databases,5);assert.equal(plan.summary.tenantDatabases,1);assert.equal(plan.summary.sessionDatabases,1);
  await assert.rejects(migrate(f.source,"postgres://unused",{}),/writers paused/);
  assert.throws(()=>preflight(f.source,{retain:[f.id+".db"]}),/operational/);
  const wal=join(f.source,"sqlite","auth.db-wal");writeFileSync(wal,"uncheckpointed data");assert.throws(()=>preflight(f.source),/unlisted/);rmSync(wal);
  const manifestFile=join(f.source,"manifest.json"),manifest=JSON.parse(readFileSync(manifestFile,"utf8"));
  const first=manifest.databases[0];first.sha256="wrong";writeFileSync(manifestFile,JSON.stringify(manifest));assert.throws(()=>preflight(f.source),/checksum/);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test("real PostgreSQL: full offline cloud migration verifies all fields, repeats safely and rejects divergent targets",{skip:process.env.ORVYN_CLOUD_MIGRATION_TEST!=="1"||!process.env.ORVYN_PG_URL},async()=>{
 const f=fixture(),admin=new Pool({connectionString:process.env.ORVYN_PG_URL});const name="cloud_migration_"+randomUUID().replace(/-/g,"");const url=new URL(process.env.ORVYN_PG_URL!);url.pathname="/"+name;
 let created=false;try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const result=await migrate(f.source,url.toString(),{writesPaused:true});assert.equal(result.completeCoreParity,true);assert.equal(result.activationPerformed,false);
  assert.deepEqual(await migrate(f.source,url.toString(),{writesPaused:true}),result);
  const target=new Pool({connectionString:url.toString()});try{await target.query("UPDATE orvyn_auth.organizations SET name='divergent'");}finally{await target.end();}
  await assert.rejects(migrate(f.source,url.toString(),{writesPaused:true}),/refusing to overwrite/);
 }finally{if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(f.dir,{recursive:true,force:true});}
});
