import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresAuthService } from "../auth/PostgresAuthService";
import { authSql } from "../auth/PostgresAuthDatabase";

const integration = process.env.ORVYN_AUTH_RUNTIME_TEST === "1" && Boolean(process.env.ORVYN_PG_URL);
const email = () => `${randomUUID()}@example.invalid`;
const password = "runtime-password-123";

test("authentication SQL keeps literal question marks and supports current upsert semantics", () => {
  assert.equal(authSql("SELECT '?' AS literal, 'it''s?' AS escaped WHERE email=? AND name=?"), "SELECT '?' AS literal, 'it''s?' AS escaped WHERE email=$1 AND name=$2");
  assert.match(authSql("INSERT OR REPLACE INTO organization_members (organization_id,user_id,role,created_at) VALUES (?,?,?,?)"), /ON CONFLICT \(organization_id,user_id\) DO UPDATE SET role=excluded.role,created_at=excluded.created_at/);
  assert.throws(() => authSql("INSERT OR REPLACE INTO unknown (id) VALUES (?)"), /Unsupported/);
});

test("real Postgres: account registration and failed-login accounting are atomic across instances", { skip:!integration }, async () => {
  const a = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const b = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const audit = new Pool({ connectionString:process.env.ORVYN_PG_URL });
  try {
    const address = email();
    const registrations = await Promise.allSettled([a.register(address,password), b.register(address.toUpperCase(),password)]);
    assert.equal(registrations.filter(result => result.status === "fulfilled").length, 1);
    const winner = registrations.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof a.register>>>;
    assert.equal((await b.verifyPrincipal(winner.value.token))!.principal.tenantId, winner.value.organization.tenantId);
    const failures = await Promise.allSettled(Array.from({ length:5 }, (_, index) => (index % 2 ? a:b).login(address,"wrong-password")));
    assert.ok(failures.every(result => result.status === "rejected"));
    const stored = await audit.query("SELECT count FROM orvyn_auth.login_failures WHERE email=$1", [address]);
    assert.equal(Number(stored.rows[0].count), 5, "credential rejection must commit its persistent failure counter");
    await assert.rejects(a.login(address,password), /Too many failed attempts/);
    await audit.query("UPDATE orvyn_auth.login_failures SET first_at=$1 WHERE email=$2", [Date.now()-16*60_000,address]);
    assert.equal((await a.login(address,password)).user.id, winner.value.user.id);
    assert.equal((await audit.query("SELECT 1 FROM orvyn_auth.login_failures WHERE email=$1", [address])).rowCount, 0);

    const broken = email();
    const before = await audit.query("SELECT (SELECT count(*) FROM orvyn_auth.organizations) AS organizations,(SELECT count(*) FROM orvyn_auth.sessions) AS sessions");
    await audit.query(`CREATE FUNCTION orvyn_auth.fail_membership_runtime_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced membership failure'; END; $$;
      CREATE TRIGGER fail_membership_runtime_test BEFORE INSERT ON orvyn_auth.organization_members FOR EACH ROW EXECUTE FUNCTION orvyn_auth.fail_membership_runtime_test()`);
    try { await assert.rejects(a.register(broken,password), /forced membership failure/); }
    finally { await audit.query("DROP TRIGGER fail_membership_runtime_test ON orvyn_auth.organization_members; DROP FUNCTION orvyn_auth.fail_membership_runtime_test()"); }
    assert.equal((await audit.query("SELECT 1 FROM orvyn_auth.users WHERE email=$1", [broken])).rowCount, 0);
    const after = await audit.query("SELECT (SELECT count(*) FROM orvyn_auth.organizations) AS organizations,(SELECT count(*) FROM orvyn_auth.sessions) AS sessions");
    assert.deepEqual(after.rows, before.rows);
  } finally { await a.close(); await b.close(); await audit.end(); }
});

test("real Postgres: password reset, OAuth state and desktop handoff consume once across instances", { skip:!integration }, async () => {
  const a = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const b = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const audit = new Pool({ connectionString:process.env.ORVYN_PG_URL });
  try {
    const account = await a.register(email(),password);
    const reset = (await a.createPasswordReset(account.user.email))!;
    await audit.query(`CREATE FUNCTION orvyn_auth.fail_password_runtime_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced password failure'; END; $$;
      CREATE TRIGGER fail_password_runtime_test BEFORE UPDATE ON orvyn_auth.users FOR EACH ROW EXECUTE FUNCTION orvyn_auth.fail_password_runtime_test()`);
    try { await assert.rejects(a.resetPassword(reset.token,"changed-password-123"), /forced password failure/); }
    finally { await audit.query("DROP TRIGGER fail_password_runtime_test ON orvyn_auth.users; DROP FUNCTION orvyn_auth.fail_password_runtime_test()"); }
    assert.ok(await b.verify(account.token), "failed reset must preserve existing sessions and token usability");
    const consumed = await Promise.allSettled([a.resetPassword(reset.token,"changed-password-123"), b.resetPassword(reset.token,"changed-password-123")]);
    assert.equal(consumed.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(await a.verify(account.token), null);
    assert.equal((await b.login(account.user.email,"changed-password-123")).user.id, account.user.id);
    const state = randomUUID();
    await a.saveOAuthState({ state,provider:"github",verifier:"private-verifier",client:"desktop" });
    const states = await Promise.all([a.takeOAuthState(state,"github"), b.takeOAuthState(state,"github")]);
    assert.equal(states.filter(Boolean).length, 1);
    const id = randomUUID().replace(/-/g, "");
    const verifier = randomUUID();
    await a.startHandoff(id,createHash("sha256").update(verifier).digest("base64url"));
    assert.equal(await b.completeHandoff(id,account.user.id), true);
    const claims = await Promise.all([a.claimHandoff(id,verifier), b.claimHandoff(id,verifier)]);
    assert.equal(claims.filter(result => result.status === "ok").length, 1);
    assert.equal(claims.filter(result => result.status === "invalid").length, 1);
  } finally { await a.close(); await b.close(); await audit.end(); }
});

test("real Postgres: tenant isolation, invitation seats, key revocation and session reuse are enforced", { skip:!integration }, async () => {
  const a = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const b = await PostgresAuthService.connect(process.env.ORVYN_PG_URL!);
  const audit = new Pool({ connectionString:process.env.ORVYN_PG_URL });
  try {
    const owner = await a.register(email(),password);
    const outsider = await b.register(email(),password);
    const principal = (await a.verifyPrincipal(owner.token))!.principal;
    const otherPrincipal = (await b.verifyPrincipal(outsider.token))!.principal;
    const project = await a.createProject(principal,"Private project");
    await assert.rejects(b.getProject(project.id,otherPrincipal.tenantId), /not found/i);
    const invites = await Promise.allSettled([a.createInvite(principal,email(),"member",1), b.createInvite(principal,email(),"member",1)]);
    assert.equal(invites.filter(result => result.status === "fulfilled").length, 1);
    const key = await a.createApiKey(principal,"Runtime key");
    assert.equal((await b.verifyApiKey(key.key))!.principal.tenantId, principal.tenantId);
    await a.revokeApiKey(owner.user.id,key.record.id);
    assert.equal(await b.verifyApiKey(key.key), null);
    const rotations = await Promise.all([a.rotateSession(owner.token), b.rotateSession(owner.token)]);
    assert.equal(rotations.filter(Boolean).length, 1);
    const rotated = rotations.find(Boolean)!;
    assert.ok(await b.verify(rotated));
    await audit.query("UPDATE orvyn_auth.session_rotations SET rotated_at=$1 WHERE old_hash=$2", [Date.now()-120_000,createHash("sha256").update(owner.token).digest("hex")]);
    assert.equal(await a.verify(owner.token), null);
    assert.equal(await b.verify(rotated), null, "old-token reuse must durably revoke the family even though verification returns null");
  } finally { await a.close(); await b.close(); await audit.end(); }
});
