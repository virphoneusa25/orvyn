import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootKey, WorkSessionStore } from "./WorkSessionStore";

test("a session survives a restart with its runs, workspace and project", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-sessions-"));
  const a = new WorkSessionStore("t1", dir);
  const s = a.create({ title: "Create hello.txt", userId: "u1", projectRoot: "C:\\Users\\me\\site" });
  assert.match(s.sessionId, /^sess_/);
  assert.match(String(s.workspaceId), /^ws_/);
  a.attachRun(s.sessionId, "run-1");
  a.attachRun(s.sessionId, "run-2");

  const b = new WorkSessionStore("t1", dir); // "the backend restarted"
  const again = b.get(s.sessionId)!;
  assert.deepEqual(again.runIds, ["run-1", "run-2"]);
  assert.equal(again.activeRunId, "run-2");
  assert.equal(again.workspaceId, s.workspaceId);
  assert.equal(b.sessionOfRun("run-1")?.sessionId, s.sessionId);
  assert.equal(b.list()[0]?.sessionId, s.sessionId);
  assert.equal(new WorkSessionStore("t2", dir).get(s.sessionId), undefined, "other tenants never see it");
});

test("the same folder is the same workspace; a session without a folder gets one from its first run", () => {
  const store = new WorkSessionStore("t1", mkdtempSync(join(tmpdir(), "orvyn-sessions-")));
  assert.equal(rootKey("C:\\Users\\Me\\Site\\"), rootKey("c:/users/me/site"));
  const one = store.create({ title: "a", projectRoot: "C:\\Users\\Me\\Site" });
  const two = store.create({ title: "b", projectRoot: "c:/users/me/site/" });
  assert.equal(one.workspaceId, two.workspaceId);
  assert.equal(one.projectId, two.projectId);
  const bare = store.create({ title: "c" });
  assert.equal(bare.workspaceId, null);
  const withRoot = store.attachRun(bare.sessionId, "r", "/srv/ws/t1")!;
  assert.match(String(withRoot.workspaceId), /^ws_/);
  assert.equal(withRoot.projectRoot, "/srv/ws/t1");
  const renamed = store.update(bare.sessionId, { title: "Website", pinned: true, status: "archived" })!;
  assert.deepEqual([renamed.title, renamed.pinned, renamed.status], ["Website", true, "archived"]);
  assert.equal(store.delete(bare.sessionId), true);
  assert.equal(store.get(bare.sessionId), undefined);
});

test("messages are stored one by one, in order, and survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-sessions-"));
  const a = new WorkSessionStore("t1", dir);
  const s = a.create({ title: "chat" });
  const m1 = a.appendMessage(s.sessionId, { messageId: "msg_a", role: "user", content: "Create hello.txt", runId: "run-1", mode: "agent" })!;
  const m2 = a.appendMessage(s.sessionId, { role: "assistant", content: "", status: "streaming" })!;
  assert.equal(m1.sequence, 1);
  assert.equal(m2.sequence, 2);
  assert.match(m2.messageId, /^msg_/);
  a.updateMessage(m2.messageId, { content: "Created hello.txt.", status: "complete" });
  // A retry with the same id updates it; it never adds a duplicate.
  a.appendMessage(s.sessionId, { messageId: "msg_a", role: "user", content: "Create hello.txt" });
  const b = new WorkSessionStore("t1", dir); // "the backend restarted"
  const all = b.messages(s.sessionId);
  assert.deepEqual(all.map((m) => [m.messageId, m.role, m.sequence, m.runId, m.status]), [
    ["msg_a", "user", 1, "run-1", "complete"],
    [m2.messageId, "assistant", 2, null, "complete"],
  ]);
  assert.equal(all[1]!.content, "Created hello.txt.");
  assert.equal(b.messages(s.sessionId, 1).length, 1, "after a sequence: only newer messages");
  assert.equal(b.messageOfRun("run-1")?.messageId, "msg_a");
  assert.equal(b.appendMessage("sess_missing", { role: "user", content: "x" }), undefined);
  const other = b.create({ title: "other" });
  assert.equal(b.appendMessage(other.sessionId, { messageId: "msg_a", role: "user", content: "hijack" }), undefined, "a message id belongs to one session");
  b.delete(s.sessionId);
  assert.equal(b.messages(s.sessionId).length, 0);
});
