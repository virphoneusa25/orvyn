// scripts/acceptance-driver.mjs
//
// Phase 4D acceptance driver: starts a FORCED-remote (OVH_WORKER) ORION run
// and streams its events as compact evidence lines. Approvals are NOT
// auto-approved — the driver surfaces them; a human approves via the same
// REST endpoint the desktop's Approve button calls.
//
// Usage: node scripts/acceptance-driver.mjs <api-key> [instruction] [modelId]

import { appendFileSync, writeFileSync } from "fs";

const BASE = process.env.ORVYN_BASE || "https://orvyn.virphoneusa.com/api/v1";
const KEY = process.argv[2];
const instruction = process.argv[3] || "Fix the failing calculator tests.";
const modelId = process.argv[4] || "ci:gpt-5.6-terra";
const LOG = process.argv[5] || "/tmp/acceptance-events.jsonl";
writeFileSync(LOG, "");

if (!KEY) {
  console.error("api key required");
  process.exit(1);
}

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "x-api-key": KEY, ...(opts.headers ?? {}) },
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const start = await api("/agent/stream/runs", {
  method: "POST",
  body: JSON.stringify({
    projectRoot: "/opt/orvyn/workspaces/calculator-fixture",
    remoteProjectRoot: "/opt/orvyn/workspaces/calculator-fixture",
    executionLocation: "OVH_WORKER",
    instruction,
    mode: "agent",
    requestedModelId: modelId,
  }),
});
console.log("START", start.status, JSON.stringify(start.data));
if (start.status !== 201) process.exit(1);
const runId = start.data.runId;
console.log("RUN_ID=" + runId);

let after = 0;
let deltaBuf = "";
const seen = new Set();
const t0 = Date.now();

function line(kind, text) {
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${kind.padEnd(22)} ${text}`);
}

while (true) {
  let data;
  try {
    ({ data } = await api(`/agent/stream/runs/${runId}/events.json?after=${after}`));
  } catch (e) {
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  for (const e of data.events ?? []) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    after = Math.max(after, e.sequence);
    appendFileSync(LOG, JSON.stringify(e) + "\n");
    const d = e.data ?? {};
    switch (e.type) {
      case "message.delta": deltaBuf += String(d.content ?? ""); break;
      case "message.completed":
        if (deltaBuf.trim()) line("narration", JSON.stringify(deltaBuf.trim().slice(0, 400)));
        deltaBuf = "";
        break;
      case "run.started": line("run.started", `instruction=${JSON.stringify(String(d.instruction ?? "").slice(0, 80))} mode=${d.mode} requestedModel=${d.requestedModelId} actualModel=${d.actualModelId} provider=${d.provider}`); break;
      case "run.execution": line("run.execution", JSON.stringify(d)); break;
      case "agent.phase": line("agent.phase", `${d.phase} — ${d.note ?? ""}`); break;
      case "sandbox.started": line("sandbox.started", `${d.container} image=${d.image} net=${d.network} capDrop=${d.capDrop}`); break;
      case "sandbox.stopped": line("sandbox.stopped", String(d.reason ?? "")); break;
      case "tool.started": line("tool.started", `${d.tool ?? ""} callId=${String(d.callId ?? "").slice(0, 10)}`); break;
      case "tool.input": line("tool.input", JSON.stringify(d.input).slice(0, 220)); break;
      case "tool.completed": line("tool.completed", `${d.tool} bytes=${d.bytes} preview=${JSON.stringify(String(d.preview ?? "").slice(0, 160))}`); break;
      case "tool.failed": line("tool.failed", `${d.tool}: ${String(d.error ?? "").slice(0, 200)}`); break;
      case "file.read": line("file.read", String(d.path)); break;
      case "file.edit": {
        const p = d.preview;
        line("file.edit", `${d.path} ${p ? `kind=${p.kind} +${p.additions}/-${p.deletions}` : "(no preview)"}`);
        if (p?.diff) for (const dl of p.diff.slice(0, 20)) line("  diff", `${dl.type === "add" ? "+" : dl.type === "remove" ? "-" : " "} ${dl.content}`);
        break;
      }
      case "terminal.started": line("terminal.started", `$ ${d.command}`); break;
      case "terminal.output": line("terminal.output", JSON.stringify(String(d.data ?? "").slice(0, 500))); break;
      case "terminal.completed": line("terminal.completed", `exitOk=${d.exitOk}${d.exitCode !== undefined ? " exit=" + d.exitCode : ""}`); break;
      case "approval.required":
        line("approval.required", `>>> callId=${d.callId} tool=${d.tool} destructive=${d.destructive}`);
        line("  approve-cmd", `curl -X POST ${BASE}/agent/stream/approvals/${d.callId} -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"approved":true}'`);
        break;
      case "approval.resolved": line("approval.resolved", `approved=${d.approved}${d.reason ? " reason=" + d.reason : ""}`); break;
      case "steer.queued": line("steer.queued", JSON.stringify(d.text).slice(0, 120)); break;
      case "steer.delivered": line("steer.delivered", JSON.stringify(d.text).slice(0, 120)); break;
      case "usage.updated": line("usage.updated", `model=${d.modelId} prompt=${d.promptTokens} completion=${d.completionTokens} turns=${d.turns} context=${d.contextTokens}/${d.contextBudget}`); break;
      case "artifacts.collected": line("artifacts", JSON.stringify(d.files).slice(0, 300)); break;
      case "checkpoint.created": line("checkpoint", `id=${d.id} files=${d.files}`); break;
      case "context.compacted": line("context.compacted", `${d.tokensBefore}→${d.tokensAfter} tokens`); break;
      case "run.completed": line("run.completed", JSON.stringify(d)); break;
      case "run.error": line("run.error", String(d.message ?? "").slice(0, 300)); break;
      case "run.cancelled": line("run.cancelled", JSON.stringify(d)); break;
      default: line(e.type, JSON.stringify(d).slice(0, 140));
    }
  }
  if (["completed", "error", "cancelled"].includes(data.status)) {
    console.log("FINAL_STATUS=" + data.status);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
