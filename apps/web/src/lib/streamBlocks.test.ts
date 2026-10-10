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

test("failed or cancelled edits are not documented as completed changes", () => {
  const start = [{type:"tool.started",data:{callId:"bad",tool:"edit_file"}},{type:"tool.input",data:{callId:"bad",input:{path:"a.ts"}}}];
  assert.equal(fileEditsFromEvents(start)[0]?.pending,true);
  assert.deepEqual(fileEditsFromEvents([...start,{type:"tool.failed",data:{callId:"bad",error:"anchor not found"}}]),[]);
  assert.deepEqual(fileEditsFromEvents([...start,{type:"run.cancelled",data:{}}]),[]);
  const previous={type:"file.edit",data:{path:"a.ts",preview:{kind:"modify",additions:1,diff:[{type:"add",content:"verified"}]}}};
  const edits=fileEditsFromEvents([previous,...start,{type:"tool.failed",data:{callId:"bad"}}]);
  assert.equal(edits[0]?.pending,false);
  assert.equal(edits[0]?.diff[0]?.content,"verified");
});
test("aliases, overwrite, rename destinations and restored persisted events show real changes", () => {
  for (const tool of ["create_file","apply_patch","write_file"]) {
    const events=[{type:"tool.started",data:{callId:"w",tool}},{type:"tool.input",data:{callId:"w",input:{path:"a.ts"}}},
      {type:"file.edit",data:{path:"a.ts",preview:{kind:"modify",additions:1,deletions:1,diff:[{type:"add",content:"new"}]}}},
      {type:"tool.completed",data:{callId:"w",tool}}];
    assert.equal(fileEditsFromEvents(events)[0]?.status,"modified");
    assert.deepEqual(fileEditsFromEvents(JSON.parse(JSON.stringify(events))),fileEditsFromEvents(events));
  }
  const moved=fileEditsFromEvents([{type:"file.edit",data:{path:"old.ts",to:"new.ts",preview:{path:"old.ts → new.ts",kind:"move"}}}]);
  assert.equal(moved[0]?.path,"old.ts");
  assert.equal(moved[0]?.openPath,"new.ts");
});
