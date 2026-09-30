import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../auth/AuthService";

function fresh() {
  const auth = new AuthService(mkdtempSync(join(tmpdir(), "orvyn-portal-")));
  const owner = auth.register("owner@example.com", "owner-pass-1", "Olive Owner");
  const ownerP = auth.verifyPrincipal(owner.token)!.principal;
  return { auth, owner, ownerP };
}

test("change password needs the current one and signs out every other device", () => {
  const { auth, owner } = fresh();
  const other = auth.login("owner@example.com", "owner-pass-1").token;
  assert.throws(() => auth.changePassword(owner.user.id, "wrong", "new-pass-123", owner.token), /current password/);
  assert.throws(() => auth.changePassword(owner.user.id, "owner-pass-1", "short", owner.token), /at least 8/);
  const ended = auth.changePassword(owner.user.id, "owner-pass-1", "new-pass-123", owner.token);
  assert.equal(ended, 1);
  assert.ok(auth.verify(owner.token), "the session that changed it stays signed in");
  assert.equal(auth.verify(other), null, "other devices are signed out");
  assert.throws(() => auth.login("owner@example.com", "owner-pass-1"));
  assert.ok(auth.login("owner@example.com", "new-pass-123").token);
});

test("team invitations respect seats, match the invited email, and join the same workspace", () => {
  const { auth, ownerP } = fresh();
  assert.throws(() => auth.createInvite(ownerP, "a@example.com", "member", 0), /doesn't include team seats/);
  const { token, invite } = auth.createInvite(ownerP, "A@Example.com", "member", 1);
  assert.equal(invite.email, "a@example.com");
  assert.throws(() => auth.createInvite(ownerP, "b@example.com", "member", 1), /seats are in use/);

  const stranger = auth.register("x@example.com", "stranger-pass", "X");
  assert.throws(() => auth.acceptInvite(token, stranger.user), /is for a@example.com/);

  const a = auth.register("a@example.com", "member-pass-1", "Ann");
  assert.equal(auth.invitesForEmail("a@example.com").length, 1);
  const org = auth.acceptInvite(token, a.user);
  assert.equal(org.id, ownerP.organizationId);
  assert.equal(auth.memberRole(ownerP.organizationId, a.user.id), "member");
  assert.throws(() => auth.acceptInvite(token, a.user), /expired or was already used/, "single use");
  const asMember = auth.principalFor(a.user.id, ownerP.organizationId)!;
  assert.equal(asMember.principal.tenantId, ownerP.tenantId, "members share the workspace tenant");
});

test("only managers invite; admins can't touch admins; the owner can't be removed", () => {
  const { auth, ownerP } = fresh();
  const m = auth.register("m@example.com", "member-pass-1", "Max");
  auth.acceptInviteById(auth.createInvite(ownerP, "m@example.com", "member", 5).invite.id, m.user);
  const memberP = auth.principalFor(m.user.id, ownerP.organizationId)!.principal;
  assert.throws(() => auth.createInvite(memberP, "z@example.com", "member", 5), /owner or an admin/);
  auth.setMemberRole(ownerP, m.user.id, "admin");
  const adminP = auth.principalFor(m.user.id, ownerP.organizationId)!.principal;
  assert.throws(() => auth.createInvite(adminP, "z@example.com", "admin", 5), /Only the owner can invite admins/);
  assert.throws(() => auth.removeMember(adminP, ownerP.userId), /owner can't be removed/);
  assert.throws(() => auth.removeMember(ownerP, ownerP.userId), /can't leave/);
  auth.removeMember(ownerP, m.user.id);
  assert.equal(auth.memberRole(ownerP.organizationId, m.user.id), null);
});

test("personal API keys: shown once, stored hashed, act as the owner, stop when revoked or removed", () => {
  const { auth, ownerP } = fresh();
  const { key, record } = auth.createApiKey(ownerP, "CI");
  assert.match(key, /^orvkey_[0-9a-f]{56}$/);
  assert.equal(record.prefix, key.slice(0, 14));
  const listed = auth.listApiKeys(ownerP.userId, ownerP.organizationId);
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(key.slice(14)), "the secret part is never listed");
  const v = auth.verifyApiKey(key)!;
  assert.equal(v.principal.tenantId, ownerP.tenantId);
  assert.equal(auth.verifyApiKey("orvkey_nope"), null);
  auth.revokeApiKey(ownerP.userId, record.id);
  assert.equal(auth.verifyApiKey(key), null);
});

test("share links: one per conversation, replaced on re-share, off when revoked", () => {
  const { auth, ownerP } = fresh();
  const first = auth.createShare(ownerP, "ses_1");
  assert.equal(auth.resolveShare(first.token)?.sessionId, "ses_1");
  const second = auth.createShare(ownerP, "ses_1");
  assert.equal(auth.resolveShare(first.token), null, "the old link stops working");
  assert.ok(auth.resolveShare(second.token));
  auth.revokeShare(ownerP.userId, "ses_1");
  assert.equal(auth.resolveShare(second.token), null);
  assert.equal(auth.resolveShare("not-a-token"), null);
});

test("projects can be renamed, described and deleted within their tenant only", () => {
  const { auth, ownerP } = fresh();
  const p = auth.createProject(ownerP, "Site");
  const u = auth.updateProject(p.id, ownerP.tenantId, { name: "Marketing site", description: "Launch page" });
  assert.equal(u.name, "Marketing site");
  assert.equal(u.description, "Launch page");
  assert.throws(() => auth.updateProject(p.id, "user_other", { name: "x" }));
  assert.throws(() => auth.deleteProject(p.id, "user_other"));
  assert.ok(auth.deleteProject(p.id, ownerP.tenantId));
  assert.equal(auth.listProjects(ownerP.tenantId).length, 0);
});
