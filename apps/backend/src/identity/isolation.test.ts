import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AuthService } from "../auth/AuthService";
import { TenantManager } from "../tenancy/TenantManager";
import { claimedTenantId, rejectTenantOverride, scopedGet } from "./isolation";
import { bindTenantResource } from "../orgs/organization";

test("signup creates a Personal Organization and session principal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-id-"));
  const auth = new AuthService(dir);
  const { user, token, organization } = auth.register("a@example.com", "password1", "User A");
  assert.equal(organization.kind, "personal");
  assert.equal(organization.name, "Personal");
  assert.equal(organization.tenantId, `user_${user.id}`);
  const session = auth.verifyPrincipal(token);
  assert.ok(session);
  assert.equal(session.principal.userId, user.id);
  assert.equal(session.principal.tenantId, organization.tenantId);
  assert.equal(session.principal.role, "owner");
  auth.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("tenant A cannot read tenant B project, chat, or guessed ids", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-iso-"));
  const auth = new AuthService(dir);
  const a = auth.register("tenant-a@example.com", "password1", "A");
  const b = auth.register("tenant-b@example.com", "password1", "B");
  const pa = auth.verifyPrincipal(a.token)!.principal;
  const pb = auth.verifyPrincipal(b.token)!.principal;
  assert.notEqual(pa.tenantId, pb.tenantId);
  assert.notEqual(pa.organizationId, pb.organizationId);

  const projectA = auth.createProject(pa, "Alpha");
  const chatA = auth.createChat(pa, "Alpha chat");
  auth.createProject(pb, "Beta");

  assert.equal(auth.listProjects(pa.tenantId).map((p) => p.id).includes(projectA.id), true);
  assert.equal(auth.listProjects(pb.tenantId).map((p) => p.id).includes(projectA.id), false);
  assert.throws(() => auth.getProject(projectA.id, pb.tenantId), /Not found/);
  assert.throws(() => auth.getChat(chatA.id, pb.tenantId), /Not found/);
  assert.throws(() => auth.getProject("prj_does_not_exist", pa.tenantId), /Not found/);

  const prevData = process.env.ORVYN_DATA_DIR;
  process.env.ORVYN_DATA_DIR = dir;
  try {
    const tm = new TenantManager();
    const tenantA = tm.ensureOrgTenant(pa);
    const tenantB = tm.ensureOrgTenant(pb);
    assert.equal(tenantA.id, pa.tenantId);
    assert.equal(tenantB.id, pb.tenantId);
    assert.notEqual(tenantA.runStore, tenantB.runStore);
    const runA = tenantA.runStore.create(`run_${pa.userId}`, pa.tenantId);
    assert.equal(tenantB.runStore.get(runA.id), undefined);
  } finally {
    if (prevData === undefined) delete process.env.ORVYN_DATA_DIR;
    else process.env.ORVYN_DATA_DIR = prevData;
  }

  auth.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("company organization members share tenant; outsiders cannot join themselves", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-orgc-"));
  const auth = new AuthService(dir);
  const a1 = auth.register("a1@example.com", "password1", "A1");
  const a2 = auth.register("a2@example.com", "password1", "A2");
  const b1 = auth.register("b1@example.com", "password1", "B1");
  const pa1 = auth.verifyPrincipal(a1.token)!.principal;
  const pa2 = auth.verifyPrincipal(a2.token)!.principal;
  const pb1 = auth.verifyPrincipal(b1.token)!.principal;
  const company = auth.createOrganization(pa1, "Acme Inc");
  auth.addOrganizationMember(pa1, company.id, pa2.userId, "member");
  assert.throws(() => auth.addOrganizationMember(pb1, company.id, pb1.userId, "member"), /Not found/);
  const switched = auth.switchOrganization(a2.token, company.id);
  assert.equal(switched.principal.tenantId, company.tenantId);
  assert.equal(switched.principal.role, "member");
  assert.throws(() => auth.switchOrganization(b1.token, company.id), /Not found/);
  auth.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("organization switch refreshes tenant context and rejects foreign orgs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-orgsw-"));
  const auth = new AuthService(dir);
  const a = auth.register("sw-a@example.com", "password1", "A");
  const b = auth.register("sw-b@example.com", "password1", "B");
  assert.throws(() => auth.switchOrganization(a.token, b.organization.id), /Not found/);
  const again = auth.switchOrganization(a.token, a.organization.id);
  assert.equal(again.principal.organizationId, a.organization.id);
  assert.notEqual(again.token, a.token);
  assert.equal(auth.verifyPrincipal(a.token), null);
  auth.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("client-supplied tenantId cannot override the session", () => {
  assert.equal(claimedTenantId({ body: { tenantId: "user_other" } }), "user_other");
  assert.throws(() => rejectTenantOverride("user_me", "user_other"), /session/);
  rejectTenantOverride("user_me", "user_me");
  rejectTenantOverride("user_me", undefined);
  assert.throws(() => bindTenantResource("user_a", "user_b"), /Not found/);
  assert.throws(() => scopedGet(null, "user_a"), /Not found/);
  assert.throws(() => scopedGet({ tenantId: "user_b" }, "user_a"), /Not found/);
  assert.equal(scopedGet({ tenantId: "user_a", id: "x" }, "user_a").id, "x");
});
