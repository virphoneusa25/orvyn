// scripts/composer-live-test.mjs
//
// Live composer-control verification against a REAL backend + REAL model:
// starts a run with explicit composer options and reports the run metadata
// plus the approval/tool event sequence. Approvals are resolved by hand or
// by the approval-watcher — this script only observes.
//
// Usage: node scripts/composer-live-test.mjs <baseUrl> <json-body>

const BASE = process.argv[2] || "http://localhost:4599/api/v1";
const body = JSON.parse(process.argv[3]);

const r = await fetch(`${BASE}/agent/stream/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const start = await r.json();
if (!r.ok) {
  console.log("START FAILED", r.status, JSON.stringify(start));
  process.exit(1);
}
console.log("runId", start.runId);
let after = 0;
for (;;) {
  let data;
  try {
    const res = await fetch(`${BASE}/agent/stream/runs/${start.runId}/events.json?after=${after}`);
    data = await res.json();
  } catch {
    await new Promise((x) => setTimeout(x, 2000));
    continue;
  }
  for (const e of data.events ?? []) {
    after = Math.max(after, e.sequence);
    const d = e.data ?? {};
    if (e.type === "run.started") console.log("[run.started]", JSON.stringify({ requested: d.requestedModelId, actual: d.actualModelId, provider: d.provider, reasoningRequested: d.reasoningEffortRequested, reasoningApplied: d.reasoningEffortApplied, permissionMode: d.permissionMode }));
    else if (e.type === "approval.required") console.log("[approval.required]", d.tool, "callId=" + d.callId);
    else if (e.type === "approval.resolved") console.log("[approval.resolved]", d.approved);
    else if (e.type === "tool.started") console.log("[tool.started]", d.tool);
    else if (e.type === "tool.completed") console.log("[tool.completed]", d.tool);
    else if (e.type === "tool.failed") console.log("[tool.failed]", d.tool, String(d.error ?? "").slice(0, 120));
    else if (e.type === "run.completed") console.log("[run.completed]", JSON.stringify(d));
    else if (e.type === "run.error") console.log("[run.error]", String(d.message ?? "").slice(0, 300));
  }
  if (["completed", "error", "cancelled"].includes(data.status)) {
    console.log("FINAL", data.status);
    break;
  }
  await new Promise((x) => setTimeout(x, 1500));
}
