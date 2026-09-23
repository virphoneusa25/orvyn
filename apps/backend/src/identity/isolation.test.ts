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
