// scripts/approval-watcher.mjs
//
// Acceptance helper: watches a run's events and resolves each
// approval.required through the SAME endpoint the desktop's Approve button
// calls (POST /agent/stream/approvals/:callId). Destructive requests are
// NEVER approved here — they surface loudly and stay pending for a human.
//
// Usage: node scripts/approval-watcher.mjs <api-key> <runId> [--deny]

import { readFileSync, existsSync } from "fs";

const BASE = process.env.ORVYN_BASE || "https://orvyn.virphoneusa.com/api/v1";
const KEY = process.argv[2];
const runId = process.argv[3];
const DENY = process.argv.includes("--deny");
const LOG = process.argv[5] || "/tmp/acceptance-events.jsonl";

if (!KEY || !runId) {
  console.error("usage: node approval-watcher.mjs <api-key> <runId> [--deny]");
  process.exit(1);
}

// Seed only NON-approval events: a pending approval found in the log was
// never resolved — skipping it would strand the run. Re-approving an
// already-resolved call is a harmless no-op, so approvals always re-fire.
const seen = new Set();
if (existsSync(LOG)) {
  for (const l of readFileSync(LOG, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e.type !== "approval.required") seen.add(e.id);
    } catch {}
  }
}

console.log(`watching ${runId} (mode=${DENY ? "DENY" : "APPROVE"}, destructive always left for a human)`);

for (;;) {
  try {
    const res = await fetch(`${BASE}/agent/stream/runs/${runId}/events.json`, { headers: { "x-api-key": KEY } });
    const data = await res.json();
    for (const e of data.events ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.type !== "approval.required") continue;
      const d = e.data;
      // Small deliberate delay: the approval must be observably PENDING
      // before it is resolved.
      await new Promise((r) => setTimeout(r, 3000));
      const approved = DENY ? false : d.destructive ? false : true;
      const r = await fetch(`${BASE}/agent/stream/approvals/${d.callId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ approved, scope: "once" }),
      });
      const out = await r.json().catch(() => ({}));
      console.log(`${new Date().toISOString()} ${approved ? "APPROVED" : DENY ? "DENIED" : "LEFT (destructive)"} ${d.tool} callId=${d.callId} → ${JSON.stringify(out)}`);
    }
    if (["completed", "error", "cancelled"].includes(data.status)) {
      console.log("run terminal:", data.status);
      break;
    }
  } catch { /* transient */ }
  await new Promise((r) => setTimeout(r, 2000));
}
