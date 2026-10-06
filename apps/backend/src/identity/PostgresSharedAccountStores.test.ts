import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresAccountStores } from "../auth/PostgresAccountStores";

const integration=process.env.ORVYN_AUTH_RUNTIME_TEST === "1" && Boolean(process.env.ORVYN_PG_URL);
const email=() => `${randomUUID()}@example.invalid`;
const password="shared-store-password-123";

test("real Postgres: staff revocation, concurrent suspension and audit rollback share account state", {skip:!integration}, async () => {
  const a=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  const b=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  const inspect=new Pool({connectionString:process.env.ORVYN_PG_URL});
  try {
    const owner=await a.auth.register(email(),password);
    const agent=await a.auth.register(email(),password);
    await a.staff.setStaff(agent.user.email,"support","test");
    const view=await a.staff.createViewAs({id:agent.user.id,email:agent.user.email}, {userId:owner.user.id,organizationId:owner.organization.id,tenantId:owner.organization.tenantId});
    assert.equal((await b.staff.resolveViewAs(view.token))!.userId,owner.user.id);
    await b.staff.removeStaff(agent.user.id);
    assert.equal(await a.staff.resolveViewAs(view.token),null,"revoking staff invalidates support views across instances");
    const superA=await a.auth.register(email(),password);
    const superB=await b.auth.register(email(),password);
    await a.staff.seedFromEnv({ORVYN_SUPER_ADMIN_EMAILS:superA.user.email});
    assert.equal(await b.staff.roleOf(superA.user.id),"super_admin");
    await b.staff.setStaff(superB.user.email,"super_admin","test");
    const removals=await Promise.allSettled([a.staff.removeStaff(superA.user.id),b.staff.removeStaff(superB.user.id)]);
    assert.equal(removals.filter(result => result.status === "fulfilled").length,1,"concurrent removal cannot remove the last super admin");
    const target=owner.organization.tenantId;
    const pauses=await Promise.allSettled([a.staff.suspend(target,{reason:"test pause",category:"security"},"test"),b.staff.suspend(target,{reason:"other pause",category:"support"},"test")]);
    assert.equal(pauses.filter(result => result.status === "fulfilled").length,1);
    assert.ok(await b.staff.suspension(target));
    assert.equal(await b.staff.reactivate(target,"test"),true);
    assert.equal(await a.staff.suspension(target),null);
    await inspect.query(`CREATE FUNCTION orvyn_auth.fail_shared_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END; $$;
      CREATE TRIGGER fail_shared_audit_test BEFORE INSERT ON orvyn_auth.admin_audit FOR EACH ROW EXECUTE FUNCTION orvyn_auth.fail_shared_audit_test()`);
    try {
      await assert.rejects(a.transaction(async stores => {
        await stores.staff.suspend(target,{reason:"must roll back",category:"security"},"test");
        await stores.staff.addNote(target,{id:agent.user.id,email:agent.user.email},"must roll back");
        await stores.staff.audit({actorId:agent.user.id,actorEmail:agent.user.email,action:"account.suspend",tenantId:target});
      }),/forced audit failure/);
    } finally { await inspect.query("DROP TRIGGER fail_shared_audit_test ON orvyn_auth.admin_audit; DROP FUNCTION orvyn_auth.fail_shared_audit_test()"); }
    assert.equal(await b.staff.suspension(target),null);
    assert.deepEqual(await b.staff.notes(target),[]);
    const record=await a.staff.audit({actorId:agent.user.id,actorEmail:agent.user.email,action:"test.record",tenantId:target});
    assert.equal((await b.staff.auditLog({tenantId:target}))[0].id,record.id);
    await assert.rejects(inspect.query("DELETE FROM orvyn_auth.admin_audit WHERE id=$1",[record.id]),/append-only/);
    const merged=await Promise.all([a.staff.saveProfile(target,{industry:"research"},"test"),b.staff.saveProfile(target,{location:"remote"},"test")]);
    assert.equal(merged.length,2);
    assert.deepEqual(await a.staff.profile(target),{website:null,industry:"research",location:"remote"});
  } finally { await a.close(); await b.close(); await inspect.end(); }
});

test("real Postgres: onboarding creation and concurrent answer updates preserve progress and analytics filtering", {skip:!integration}, async () => {
  const a=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  const b=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  try {
    const account=await a.auth.register(email(),password);
    const id=account.user.id;
    const created=await Promise.all([a.onboarding.ensure(id,"verification"),b.onboarding.ensure(id,"verification")]);
    assert.equal(created[0].id,created[1].id);
    await Promise.all([
      a.onboarding.update(id,{completed:["verification"],answers:{name:"Shared User",responseStyle:"concise"}}),
      b.onboarding.update(id,{completed:["provisioning"],answers:{memory:true,workStyle:"plan_first"}}),
    ]);
    const progress=(await b.onboarding.get(id))!;
    assert.equal(progress.answers.name,"Shared User");
    assert.equal(progress.answers.memory,true);
    assert.deepEqual(progress.completedSteps,["verification","provisioning"]);
    const complete=await a.onboarding.update(id,{step:"complete"},1000);
    assert.equal((await b.onboarding.update(id,{step:"complete"},2000)).completedAt,complete.completedAt);
    assert.ok(complete.completedSteps.includes("first_mission"));
    await a.onboarding.track(id,"onboarding_completed",{step:"complete",token:"sensitive",email:"private",count:1});
    await a.onboarding.track(id,"unknown_event",{step:"ignored"});
    const events=(await b.onboarding.events("onboarding_completed")).filter(event => event.userId === id);
    assert.equal(events.length,1);
    assert.deepEqual(events[0].props,{step:"complete",count:1});
    assert.equal((await b.onboarding.events("unknown_event")).length,0);
  } finally { await a.close(); await b.close(); }
});

test("real Postgres: account, onboarding and staff writes roll back as one transaction", {skip:!integration}, async () => {
  const a=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  const b=await PostgresAccountStores.connect(process.env.ORVYN_PG_URL!);
  const inspect=new Pool({connectionString:process.env.ORVYN_PG_URL});
  try {
    const address=email();
    let failedId="";
    await assert.rejects(a.transaction(async stores => {
      const account=await stores.auth.register(address,password);
      failedId=account.user.id;
      await stores.onboarding.ensure(failedId,"name");
      await stores.staff.setStaff(address,"readonly","test");
      await stores.staff.audit({actorId:failedId,actorEmail:address,action:"test.rollback"});
      throw new Error("abort shared account change");
    }),/abort shared account change/);
    assert.equal((await inspect.query("SELECT 1 FROM orvyn_auth.users WHERE email=$1",[address])).rowCount,0);
    assert.equal(await b.onboarding.get(failedId),null);
    assert.equal(await b.staff.roleOf(failedId),null);
    assert.equal((await inspect.query("SELECT 1 FROM orvyn_auth.admin_audit WHERE actor_id=$1",[failedId])).rowCount,0);
    const account=await a.transaction(async stores => {
      const result=await stores.auth.register(address,password);
      await stores.onboarding.ensure(result.user.id,"name");
      await stores.staff.setStaff(address,"readonly","test");
      await stores.staff.audit({actorId:result.user.id,actorEmail:address,action:"test.commit"});
      return result;
    });
    assert.ok(await b.auth.verify(account.token));
    assert.ok(await b.onboarding.get(account.user.id));
    assert.equal(await b.staff.roleOf(account.user.id),"readonly");
    await assert.rejects(a.transaction(async stores => {
      await stores.staff.addNote(account.organization.tenantId,{id:account.user.id,email:address},"must not commit on login rejection");
      await stores.auth.login(address,"wrong-password");
    }),/Invalid email or password/);
    assert.deepEqual(await b.staff.notes(account.organization.tenantId),[],"composite transactions roll back all writes on any rejection");
  } finally { await a.close(); await b.close(); await inspect.end(); }
});
