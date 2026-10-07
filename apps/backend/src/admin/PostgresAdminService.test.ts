import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresAdminDatabase, adminSql } from "./PostgresAdminDatabase";
import { PostgresAdminService } from "./PostgresAdminService";
import { PostgresAccountStores } from "../auth/PostgresAccountStores";
import { PostgresFinancialStores } from "../billing/PostgresFinancialStores";
import { PostgresWorkSessionStore } from "../sessions/PostgresWorkSessionStore";
import { Pool } from "pg";

const integration=process.env.ORVYN_ADMIN_RUNTIME_TEST==="1" && Boolean(process.env.ORVYN_PG_URL);
test("report SQL preserves literal question marks and uses UTC days and explicit schemas",()=>{
  assert.equal(adminSql("SELECT '?' FROM b.wallets WHERE account_id = ?"),"SELECT '?' FROM orvyn_billing.wallets WHERE account_id = $1");
  assert.match(adminSql("SELECT substr(datetime(created_at/1000,'unixepoch'),1,10) AS day FROM b.usage_events"),/AT TIME ZONE 'UTC'/);
});
test("real PostgreSQL: all admin reports use shared account, financial and tenant session data",{skip:!integration},async()=>{
  const url=process.env.ORVYN_PG_URL!;
  const accounts=await PostgresAccountStores.connect(url);
  const financial=await PostgresFinancialStores.connect(url);
  const database=new PostgresAdminDatabase(url);
  const reports=new PostgresAdminService(database,financial.ledger,financial.payments,accounts.staff);
  const inspect=new Pool({connectionString:url});
  let sessions:PostgresWorkSessionStore|undefined;
  try{
    const email=randomUUID()+"@example.invalid";
    const account=await accounts.auth.register(email,"admin-report-fixture-123");
    const id=account.organization.tenantId;
    await financial.ledger.ensureAccount(id);
    await financial.ledger.setPlan(id,"starter",Date.now());
    await financial.ledger.charge({eventId:randomUUID(),userId:id,type:"model",provider:"fixture",model:"fixture",providerCostUsd:0.001,now:Date.now()});
    await financial.payments.saveCustomer(id,"cus_"+randomUUID(),email);
    assert.equal((await reports.orgByTenant(id))?.id,account.organization.id);
    assert.equal((await reports.owner(id))?.email,email);
    const list=await reports.customers({q:email});
    assert.equal(list.total,1);assert.equal(list.customers[0].id,id);
    assert.ok(list.counts.all>0);
    const detail=await reports.customer(id);
    assert.equal(detail?.contact?.email,email);
    assert.equal(typeof detail?.usageCompare.cycle.now,"number");
    assert.equal((await reports.search(email)).users[0].email,email);
    assert.ok((await reports.usageSeries(id)).some(d=>d.credits>0));
    assert.ok((await reports.providerCosts()).models.some(m=>m.provider==="fixture"));
    assert.ok((await reports.topConsumers()).some(c=>c.tenantId===id));
    await reports.adjustments();await reports.ledger(id);await reports.subscriptions({});await reports.topups();
    await reports.projects(id);
    assert.deepEqual(await reports.workspaces(id),[]);
    assert.deepEqual(await reports.chats(id),[]);
    sessions=await PostgresWorkSessionStore.connect(url,id);
    // Read only selected metadata; never load message content or initialize a tenant runtime.
    const schema=sessionsSchema(id);
    await inspect.query(`INSERT INTO ${schema}.workspaces(workspace_id,project_id,root_key,project_root,created_at) VALUES($1,$2,$3,$4,$5)`,["w","p","r",encodeSessionText("C:\\fixture"),Date.now()]);
    await inspect.query(`INSERT INTO ${schema}.work_sessions(session_id,tenant_id,title,created_at,updated_at) VALUES($1,$2,$3,$4,$4)`,["s",id,encodeSessionText("Fixture \\ title"),Date.now()]);
    assert.equal((await reports.workspaces(id))[0].id,"w");
    assert.equal((await reports.chats(id))[0].title,"Fixture \\ title");
    await reports.activity(null);await reports.dashboard();await reports.sessionStats();await reports.ping();
    await assert.rejects(database.transaction(async()=>{await database.prepare("DELETE FROM organizations").all();}),/read-only/);
    await assert.rejects(database.transaction(()=>database.sessions(id,db=>db.prepare("SELECT nonexistent FROM work_sessions").all(),[])),/does not exist/);
  }finally{await sessions?.close();await inspect.end();await reports.close();await financial.close();await accounts.close();}
});
import {encodeSessionText, sessionSchema as sessionsSchema} from "../sessions/PostgresSessionDatabase";
