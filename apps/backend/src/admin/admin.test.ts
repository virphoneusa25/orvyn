import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StaffStore, can } from "./staffStore";
import { costClass, statusOf } from "./AdminService";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-staff-"));

test("staff roles grant only their permissions", () => {
  assert.equal(can("super_admin", "staff.manage"), true);
  assert.equal(can("billing", "billing.write"), true);
  assert.equal(can("billing", "account.suspend"), false);
  assert.equal(can("support", "billing.write"), false);
  assert.equal(can("support", "support.write"), true);
  assert.equal(can("readonly", "read"), true);
  assert.equal(can("readonly", "support.write"), false);
  assert.equal(can(null, "read"), false);
});

test("the audit log is append-only", () => {
  const s = new StaffStore(dir());
  s.audit({ actorId: "u1", actorEmail: "a@x", action: "credits.adjust", tenantId: "t1", detail: { credits: 5 } });
  assert.equal(s.auditLog({ tenantId: "t1" }).length, 1);
  assert.throws(() => s.db.prepare("DELETE FROM admin_audit").run());
  assert.throws(() => s.db.prepare("UPDATE admin_audit SET action = 'x'").run());
});

test("pause and reactivate keep history and refuse a double pause", () => {
  const s = new StaffStore(dir());
  assert.equal(s.suspension("t1"), null);
  s.suspend("t1", { reason: "Chargeback", category: "billing" }, "a@x");
  assert.equal(s.suspension("t1")?.category, "billing");
  assert.throws(() => s.suspend("t1", { reason: "again", category: "billing" }, "a@x"));
  assert.throws(() => s.suspend("t2", { reason: " ", category: "billing" }, "a@x"));
  assert.equal(s.reactivate("t1", "a@x"), true);
  assert.equal(s.suspension("t1"), null);
  assert.equal(s.reactivate("t1", "a@x"), false);
});

test("staff are seeded from ORVYN_SUPER_ADMIN_EMAILS and the last super admin stays", () => {
  const d = dir();
  const s = new StaffStore(d);
  s.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'boss@x.com', 'B', 'h', 1)").run();
  s.seedFromEnv({ ORVYN_SUPER_ADMIN_EMAILS: "Boss@X.com, other@x.com" } as NodeJS.ProcessEnv);
  assert.equal(s.roleOf("u1"), "super_admin");
  assert.throws(() => s.removeStaff("u1"), /last super admin/);
});

test("view-as tokens are hashed, expire, and die with the staff role", () => {
  const s = new StaffStore(dir());
  s.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('st', 'st@x.com', 'S', 'h', 1)").run();
  s.db.prepare("INSERT INTO platform_staff (user_id, role, created_at) VALUES ('st', 'support', 1)").run();
  const v = s.createViewAs({ id: "st", email: "st@x.com" }, { userId: "c", organizationId: "o", tenantId: "t" });
  assert.match(v.token, /^orvview_/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM view_as_sessions WHERE token_hash = ?").get(v.token) ? (s.db.prepare("SELECT COUNT(*) AS n FROM view_as_sessions WHERE token_hash = ?").get(v.token) as { n: number }).n : 0, 0);
  assert.equal(s.resolveViewAs(v.token)?.tenantId, "t");
  s.db.prepare("DELETE FROM platform_staff").run();
  assert.equal(s.resolveViewAs(v.token), null);
  const x = s.createViewAs({ id: "st", email: "st@x.com" }, { userId: "c", organizationId: "o", tenantId: "t" }, -1);
  assert.equal(s.resolveViewAs(x.token), null);
});

test("customer status and cost classes", () => {
  assert.equal(statusOf(true, "active"), "paused");
  assert.equal(statusOf(false, "past_due"), "past_due");
  assert.equal(statusOf(false, "trialing"), "trial");
  assert.equal(statusOf(false, "canceled"), "cancelled");
  assert.equal(statusOf(false, "none"), "active");
  assert.equal(costClass("image", "image"), "Vision & images");
  assert.equal(costClass("deep", "model"), "Reasoning");
  assert.equal(costClass("build", "model"), "Code");
  assert.equal(costClass("auto", "model"), "Text models");
});
