import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../agent/events";
import { WorkSessionStore } from "./WorkSessionStore";
import { collectSessionOutputs, previewSiteId, sessionState } from "./sessionState";

const done = (tool: string, file: string, operation: string, extra: Record<string, unknown> = {}) => ({
  type: "tool.completed", timestamp: 1, data: { tool, ...extra, envelope: { status: "success", evidence: [{ type: "file", file, operation }] } },
});

test("a session's outputs: changed files (newest op), artifacts, newest preview; verifier reads are not work", () => {
  const out = collectSessionOutputs([
    { id: "r1", events: [done("write_file", "index.html", "write"), done("write_file", "style.css", "write"), { type: "preview.available", timestamp: 2, data: { url: "http://h/api/v1/sites/abc/" } }] as any },
    { id: "r2", events: [done("edit_file", "index.html", "edit"), done("read_file", "notes.md", "read"), done("write_file", "x.txt", "write", { verifier: true }),
      { type: "artifact.created", timestamp: 3, data: { artifactId: "a1", name: "logo.png", mimeType: "image/png" } }] as any },
  ]);
  assert.deepEqual(out.files.map((f) => [f.path, f.operation, f.runId]), [["style.css", "write", "r1"], ["index.html", "edit", "r2"]]);
  assert.deepEqual(out.artifacts.map((a) => a.name), ["logo.png"]);
  assert.equal(out.preview?.url, "http://h/api/v1/sites/abc/");
  assert.equal(previewSiteId("http://h/api/v1/sites/abc/index.html"), "abc");
});

test("project files remain after the preview publication is gone",  async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-state-"));
  const sessions = new WorkSessionStore("tenant_a", dir);
  const created = sessions.provisionWorkspace();
  writeFileSync(join(created.projectRoot, "index.html"), "<h1>Harbor</h1>\n");
  writeFileSync(join(created.projectRoot, "styles.css"), "body{background:#0b1020}\n");
  const opened = sessions.create({ title: "Harbor", projectRoot: null });
  sessions.bindWorkspace(opened.sessionId, created);
  const store = new RunStore();
  const run = store.create("run_site", created.projectRoot);
  store.emit(run.id, "preview.available", { url: "http://127.0.0.1:4570/api/v1/sites/missing/" });
  store.emit(run.id, "artifact.created", { artifactId: "art_1", name: "logo.png", mimeType: "image/png" });
  sessions.attachRun(opened.sessionId, run.id, created.projectRoot);
  const state = (await sessionState(sessions, store, sessions.get(opened.sessionId)!));
  assert.deepEqual(state.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(state.preview?.available, false);
  assert.match(state.preview?.url ?? "", /missing/);
  assert.equal(state.artifacts[0]?.name, "logo.png");
  assert.equal(state.runs.length, 1);
  assert.equal(state.session.workspaceId, created.workspaceId);
  sessions.close();
});
