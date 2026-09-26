import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { WorkSessionStore } from "../sessions/WorkSessionStore";
import { makeWriteFileTool } from "../ai/tools/fileTools";
import { inspectWorkspace } from "./workspaceContext";
import {
  WORKSPACE_STATE_MISMATCH,
  exposeProjectTools,
  resolveRunWorkspace,
  workspaceModelNote,
} from "./workspacePreflight";

function open(dir: string) {
  const sessions = new WorkSessionStore("t1", dir);
  const session = sessions.create({ title: "New conversation", projectRoot: null });
  return { sessions, session };
}

test("TEST A — a new website provisions one workspace and can write index.html there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ws-a-"));
  const cwd = mkdtempSync(join(tmpdir(), "orvyn-cwd-a-"));
  const { sessions, session } = open(dir);
  const resolved = resolveRunWorkspace({
    sessions,
    tenantId: "t1",
    session,
    instruction: "Build a simple website.",
    clientRoot: ".",
    cwd,
  });
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(resolved.created, true);
  assert.equal(resolved.restored, false);
  assert.equal(resolved.fresh, true);
  assert.equal(exposeProjectTools(resolved), true);
  assert.match(basename(resolved.projectRoot), /^ws_/);
  assert.equal(resolved.projectRoot.includes(`${join("tenants", "t1", "workspaces")}`), true);
  assert.notEqual(resolved.projectRoot, cwd);
  assert.notEqual(resolved.projectRoot, ".");
  assert.equal(resolved.projectRoot.endsWith("/opt/orvyn/workspaces"), false);
  assert.equal(existsSync(resolved.projectRoot), true);
  assert.equal(readdirSync(join(dir, "tenants", "t1", "workspaces")).length, 1);

  const note = workspaceModelNote(resolved);
  assert.match(note, /just provisioned/);
  assert.match(note, /not an error/);
  assert.equal(note.includes(resolved.projectRoot), false);

  const wrote = await makeWriteFileTool(resolved.projectRoot).execute({ path: "index.html", content: "<h1>Hello</h1>\n" });
  assert.equal(wrote.ok, true);
  assert.equal(existsSync(join(resolved.projectRoot, "index.html")), true);
  assert.equal(existsSync(join(cwd, "index.html")), false);
  assert.equal(existsSync(join(dir, "index.html")), false);
  sessions.rememberFiles(resolved.workspaceId, ["index.html"]);
});

test("TEST B — a follow-up after restart keeps the same workspace and edits index.html", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ws-b-"));
  const cwd = mkdtempSync(join(tmpdir(), "orvyn-cwd-b-"));
  const first = open(dir);
  const created = resolveRunWorkspace({
    sessions: first.sessions,
    tenantId: "t1",
    session: first.session,
    instruction: "Build a simple website.",
    clientRoot: "/opt/orvyn/workspaces",
    cwd,
  });
  assert.equal(created.status, "resolved");
  if (created.status !== "resolved") return;
  await makeWriteFileTool(created.projectRoot).execute({ path: "index.html", content: "<h1>Hello</h1>\n" });
  first.sessions.rememberFiles(created.workspaceId, ["index.html"]);

  const reopened = new WorkSessionStore("t1", dir);
  const session = reopened.get(created.sessionId);
  assert.ok(session);
  const wrong = mkdtempSync(join(tmpdir(), "orvyn-wrong-b-"));
  const follow = resolveRunWorkspace({
    sessions: reopened,
    tenantId: "t1",
    session: session!,
    instruction: "Add a contact section.",
    clientRoot: wrong,
    cwd,
  });
  assert.equal(follow.status, "resolved");
  if (follow.status !== "resolved") return;
  assert.equal(follow.sessionId, created.sessionId);
  assert.equal(follow.projectId, created.projectId);
  assert.equal(follow.workspaceId, created.workspaceId);
  assert.equal(follow.projectRoot, created.projectRoot);
  assert.equal(follow.created, false);
  assert.equal(follow.restored, true);
  assert.equal(follow.fresh, false);
  assert.match(readFileSync(join(follow.projectRoot, "index.html"), "utf8"), /Hello/);

  const edited = await makeWriteFileTool(follow.projectRoot).execute({
    path: "index.html",
    content: "<h1>Hello</h1>\n<section id=\"contact\">Contact</section>\n",
  });
  assert.equal(edited.ok, true);
  assert.match(readFileSync(join(created.projectRoot, "index.html"), "utf8"), /contact/i);
  assert.equal(existsSync(join(wrong, "index.html")), false);
  assert.equal(readdirSync(join(dir, "tenants", "t1", "workspaces")).length, 1);
});

test("TEST C — a wrong or empty path is not a new project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ws-c-"));
  const cwd = mkdtempSync(join(tmpdir(), "orvyn-cwd-c-"));
  const first = open(dir);
  const created = resolveRunWorkspace({
    sessions: first.sessions,
    tenantId: "t1",
    session: first.session,
    instruction: "Build a simple website.",
    clientRoot: "",
    cwd,
  });
  assert.equal(created.status, "resolved");
  if (created.status !== "resolved") return;
  writeFileSync(join(created.projectRoot, "index.html"), "<h1>Hello</h1>\n");
  first.sessions.rememberFiles(created.workspaceId, ["index.html"]);

  const wrong = mkdtempSync(join(tmpdir(), "orvyn-empty-c-"));
  const restored = resolveRunWorkspace({
    sessions: first.sessions,
    tenantId: "t1",
    session: first.sessions.get(created.sessionId)!,
    instruction: "Add a contact section.",
    clientRoot: wrong,
    cwd,
  });
  assert.equal(restored.status, "resolved");
  if (restored.status !== "resolved") return;
  assert.equal(restored.workspaceId, created.workspaceId);
  assert.equal(restored.projectId, created.projectId);
  assert.equal(restored.projectRoot, created.projectRoot);
  assert.equal(restored.created, false);
  assert.equal(existsSync(join(wrong, "index.html")), false);

  rmSync(join(created.projectRoot, "index.html"));
  mkdirSync(wrong, { recursive: true });
  const drifted = first.sessions.bindWorkspace(created.sessionId, {
    workspaceId: created.workspaceId,
    projectId: created.projectId,
    projectRoot: wrong,
  });
  assert.equal(drifted?.projectRoot, wrong);

  const mismatch = resolveRunWorkspace({
    sessions: first.sessions,
    tenantId: "t1",
    session: first.sessions.get(created.sessionId)!,
    instruction: "Add a contact section.",
    clientRoot: wrong,
    cwd,
  });
  assert.equal(mismatch.status, "mismatch");
  if (mismatch.status !== "mismatch") return;
  assert.equal(mismatch.code, WORKSPACE_STATE_MISMATCH);
  assert.equal(exposeProjectTools(mismatch), false);
  assert.equal(mismatch.created, false);
  assert.equal(mismatch.workspaceId, created.workspaceId);
  assert.equal(mismatch.projectId, created.projectId);
  assert.equal(mismatch.projectRoot, created.projectRoot);
  assert.notEqual(mismatch.projectRoot, wrong);
  const after = first.sessions.get(created.sessionId);
  assert.equal(after?.workspaceId, created.workspaceId);
  assert.equal(after?.projectId, created.projectId);
  assert.equal(after?.projectRoot, created.projectRoot);
  assert.equal(readdirSync(join(dir, "tenants", "t1", "workspaces")).length, 1);
  assert.equal(readdirSync(wrong).length, 0);
  assert.equal(existsSync(join(created.projectRoot, "index.html")), false);
});

test("an informational question does not allocate a workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-ws-info-"));
  const { sessions, session } = open(dir);
  const skipped = resolveRunWorkspace({
    sessions,
    tenantId: "t1",
    session,
    instruction: "What is a closure in JavaScript?",
    clientRoot: ".",
    cwd: dir,
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(exposeProjectTools(skipped), false);
  assert.equal(existsSync(join(dir, "tenants")), false);
});

test("a blank project root is not the backend process directory", () => {
  const missing = inspectWorkspace("");
  assert.equal(missing.available, false);
  assert.equal(missing.path, "");
  const dot = inspectWorkspace(".");
  assert.equal(dot.available, false);
  assert.notEqual(dot.path, process.cwd());
});
