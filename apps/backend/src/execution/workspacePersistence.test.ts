import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkSessionStore } from "../sessions/WorkSessionStore";
import { makeReadFileTool } from "../ai/tools/fileTools";
import {
  destroySandbox,
  stageCanonicalWorkspace,
  syncSandboxToCanonical,
} from "./workspaceSync";
import { applyCanonicalSync, canonicalRootForRun, listCanonicalFiles, queueExecutorJob } from "../routes/worker";

const INDEX = "<!doctype html>\n<html><body><h1>ORVYN</h1></body></html>\n";
const CSS = "body { margin: 0; background: #0b1020; }\n";
const INDEX_AFTER_WORKER = "<!doctype html>\n<html><body><h1>ORVYN</h1><p>hero</p></body></html>\n";

test("provisioned workspace files survive desktop restart, backend restart, worker destroy, and session reopen", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "orvyn-persist-"));
  const tenantId = "tenant_a";
  const sessions = new WorkSessionStore(tenantId, dataDir);
  const session = sessions.create({ title: "Website", projectRoot: null });
  const created = sessions.provisionWorkspace();
  const bound = sessions.bindWorkspace(session.sessionId, created);
  assert.ok(bound);
  const canonical = created.projectRoot;
  assert.equal(
    canonical,
    realpathSync(join(dataDir, "tenants", tenantId, "workspaces", created.workspaceId))
  );
  writeFileSync(join(canonical, "index.html"), INDEX);
  writeFileSync(join(canonical, "styles.css"), CSS);
  sessions.rememberFiles(created.workspaceId, ["index.html", "styles.css"]);

  // TEST A — restart the desktop only. The desktop cache is not the project.
  const desktopCache: { sessionId: string; knownFiles: string[] } = {
    sessionId: session.sessionId,
    knownFiles: sessions.knownFiles(created.workspaceId),
  };
  assert.deepEqual(desktopCache.knownFiles, ["index.html", "styles.css"]);
  const restartedDesktop = null;
  void restartedDesktop;
  assert.equal(readFileSync(join(canonical, "index.html"), "utf8"), INDEX);
  assert.equal(readFileSync(join(canonical, "styles.css"), "utf8"), CSS);

  // TEST B — restart the backend. A new store opens the same data directory.
  sessions.close();
  const restarted = new WorkSessionStore(tenantId, dataDir);
  const record = restarted.getWorkspace(created.workspaceId);
  assert.ok(record);
  assert.equal(record.projectRoot, canonical);
  assert.equal(readFileSync(join(record.projectRoot, "index.html"), "utf8"), INDEX);
  assert.equal(readFileSync(join(record.projectRoot, "styles.css"), "utf8"), CSS);

  // The worker is given a Windows checkout path and must still use the durable directory.
  const runId = "run_persist_ws";
  queueExecutorJob(runId, "C:\\Users\\builder\\site", {
    tenantId,
    organizationId: tenantId,
    userId: "user_a",
    projectId: created.projectId,
    runId,
  }, canonical);
  assert.equal(canonicalRootForRun(runId), canonical);
  const stagedPayload = listCanonicalFiles(runId);
  assert.equal(stagedPayload.canonical, true);
  const byPath = new Map(stagedPayload.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64").toString("utf8")]));
  assert.equal(byPath.get("index.html"), INDEX);
  assert.equal(byPath.get("styles.css"), CSS);

  // TEST C — stage into a sandbox, let the worker edit, destroy the sandbox.
  const sandbox = mkdtempSync(join(tmpdir(), "orvyn-sandbox-"));
  const staged = stageCanonicalWorkspace(canonical, sandbox);
  assert.deepEqual(staged.sort(), ["index.html", "styles.css"]);
  assert.equal(readFileSync(join(sandbox, "index.html"), "utf8"), INDEX);
  writeFileSync(join(sandbox, "index.html"), INDEX_AFTER_WORKER);
  rmSync(join(sandbox, "styles.css"));
  const synced = syncSandboxToCanonical(sandbox, canonical);
  assert.deepEqual(synced, ["index.html"]);
  const pushed = stagedPayload.files.map((file) =>
    file.path === "index.html"
      ? { path: "index.html", contentBase64: Buffer.from(INDEX_AFTER_WORKER, "utf8").toString("base64") }
      : file
  );
  const applied = applyCanonicalSync(runId, pushed);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(applied.written.sort(), ["index.html", "styles.css"]);

  destroySandbox(sandbox, canonical);
  assert.equal(existsSync(sandbox), false);
  assert.equal(existsSync(canonical), true);
  assert.equal(readFileSync(join(canonical, "index.html"), "utf8"), INDEX_AFTER_WORKER);
  assert.equal(readFileSync(join(canonical, "styles.css"), "utf8"), CSS);
  assert.throws(() => destroySandbox(canonical, canonical), /refusing to delete canonical workspace/);
  assert.equal(readFileSync(join(canonical, "index.html"), "utf8"), INDEX_AFTER_WORKER);

  // Recreate the worker sandbox from the canonical tree. The first sandbox is gone.
  const recreated = mkdtempSync(join(tmpdir(), "orvyn-sandbox-"));
  stageCanonicalWorkspace(canonical, recreated);
  assert.equal(readFileSync(join(recreated, "index.html"), "utf8"), INDEX_AFTER_WORKER);
  assert.equal(readFileSync(join(recreated, "styles.css"), "utf8"), CSS);
  destroySandbox(recreated, canonical);
  assert.equal(existsSync(recreated), false);
  assert.equal(readFileSync(join(canonical, "styles.css"), "utf8"), CSS);

  // TEST D — reopen the session and read both files. Bytes match the canonical tree.
  restarted.close();
  const reopened = new WorkSessionStore(tenantId, dataDir);
  const again = reopened.get(session.sessionId);
  assert.ok(again?.workspaceId);
  const workspace = reopened.getWorkspace(again.workspaceId);
  assert.ok(workspace);
  assert.equal(workspace.projectRoot, canonical);
  const read = makeReadFileTool(workspace.projectRoot);
  const html = await read.execute({ path: "index.html" });
  const css = await read.execute({ path: "styles.css" });
  assert.equal(html.ok, true);
  assert.equal(css.ok, true);
  assert.equal(html.output, INDEX_AFTER_WORKER);
  assert.equal(css.output, CSS);
  assert.equal(readFileSync(join(workspace.projectRoot, "index.html"), "utf8"), html.output);
  assert.equal(readFileSync(join(workspace.projectRoot, "styles.css"), "utf8"), css.output);
  reopened.close();
});

test("a sync with no canonical workspace does not invent a project folder", () => {
  const orphan = applyCanonicalSync("run_without_workspace", [
    { path: "index.html", contentBase64: Buffer.from(INDEX, "utf8").toString("base64") },
  ]);
  assert.equal(orphan.ok, false);
  if (orphan.ok) return;
  assert.match(orphan.error, /no canonical workspace/);
});

test("staging refuses to treat the canonical directory as the sandbox", () => {
  const canonical = mkdtempSync(join(tmpdir(), "orvyn-canon-"));
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, "index.html"), INDEX);
  assert.throws(() => stageCanonicalWorkspace(canonical, canonical), /different directories/);
  assert.equal(readFileSync(join(canonical, "index.html"), "utf8"), INDEX);
  assert.throws(() => destroySandbox(canonical, canonical), /refusing to delete canonical workspace/);
  assert.equal(existsSync(join(canonical, "index.html")), true);
});
