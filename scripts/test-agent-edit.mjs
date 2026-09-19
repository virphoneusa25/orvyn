// scripts/test-agent-edit.mjs
// End-to-end proof that Agent mode really edits files: start a run via the
// same endpoints the desktop UI uses, auto-approve tool calls, then verify
// the file changed on disk.
import { readFileSync } from "node:fs";

const API = "http://localhost:4570/api/v1";
const root = "C:/Users/rmckn/orvyn-agent-test";

const res = await fetch(`${API}/agent/stream/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    projectRoot: root,
    mode: "agent",
    instruction:
      "Open hello.txt, change version=1 to version=2, and add a second line that says 'edited by agent'. Actually write the file to disk.",
  }),
});
const { runId, error } = await res.json();
if (!runId) {
  console.error("FAIL: could not start run:", error);
  process.exit(1);
}
console.log("run started:", runId);

let after = 0;
const deadline = Date.now() + 180_000;
let status = "running";
while (Date.now() < deadline) {
  const r = await fetch(`${API}/agent/stream/runs/${runId}/events.json?after=${after}`);
  const data = await r.json();
  status = data.status;
  for (const e of data.events ?? []) {
    after = Math.max(after, e.sequence);
    const summary = JSON.stringify(e.data ?? {}).slice(0, 160);
    console.log(`  [${e.type}] ${summary}`);
    if (e.type === "approval.required") {
      const callId = e.data?.callId;
      console.log(`  -> approving ${e.data?.tool} (${callId})`);
      await fetch(`${API}/agent/stream/approvals/${callId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, scope: "once" }),
      });
    }
  }
  if (status === "completed" || status === "error") break;
  await new Promise((r2) => setTimeout(r2, 500));
}

const content = readFileSync(`${root}/hello.txt`, "utf-8");
console.log(`\nrun status: ${status}\nfile content now:\n${content}`);
if (content.includes("version=2") && content.toLowerCase().includes("edited by agent")) {
  console.log("PASS — the agent actually edited the file on disk.");
} else {
  console.error("FAIL — file was not edited.");
  process.exit(1);
}
