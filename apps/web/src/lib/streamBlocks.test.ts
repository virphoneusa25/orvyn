import assert from "node:assert/strict";
import test from "node:test";
import { activityLabel, collapseReadFailures, fileEditsFromEvents, upsertActivity } from "./streamBlocks.ts";

test("chat activities stay in the stream as a completed log", () => {
  const running = upsertActivity([], { id: "a1", kind: "read", status: "running", url: "https://kernelailabs.com/" });
  assert.equal(activityLabel(running[0]!), "Reading kernelailabs.com");
  const done = upsertActivity(running, { id: "a1", kind: "read", status: "done", url: "https://kernelailabs.com/", title: "Kernel AI Labs" });
  assert.equal(done.length, 1);
  assert.equal(activityLabel(done[0]!), "Read Kernel AI Labs");
});

test("file.edit events become expandable stream cards with the diff", () => {
  const pending = fileEditsFromEvents([
    { type: "tool.started", data: { callId: "c1", tool: "edit_file", args: { path: "src/Button.tsx" } } },
  ]);
  assert.equal(pending[0]?.pending, true);
  assert.equal(pending[0]?.path, "src/Button.tsx");
  const done = fileEditsFromEvents([
    { type: "tool.started", data: { callId: "c1", tool: "edit_file" } },
    { type: "file.edit", data: { path: "src/Button.tsx", preview: { path: "src/Button.tsx", kind: "modify", additions: 1, deletions: 1, diff: [{ type: "remove", content: 'const color = "blue";' }, { type: "add", content: 'const color = "indigo";' }] } } },
  ]);
  assert.equal(done[0]?.pending, false);
  assert.equal(done[0]?.additions, 1);
  assert.equal(done[0]?.diff.length, 2);
});

test("repeated failed page reads on one host collapse to one public error", () => {
  const collapsed = collapseReadFailures([
    { id: "1", kind: "read", status: "failed", url: "https://www.virphoneusa.com/", error: "Could not read https://www.virphoneusa.com/: HTTP 401 Forbidden. OpenShell will not allow host *." },
    { id: "2", kind: "read", status: "failed", url: "https://www.virphoneusa.com/pricing", error: "HTTP 401" },
    { id: "3", kind: "read", status: "failed", url: "https://r.jina.ai/https://www.virphoneusa.com/", error: "HTTP 403" },
  ]);
  assert.equal(collapsed.length, 2);
  assert.doesNotMatch(String(collapsed[0]?.error), /OpenShell|host \*/);
});
