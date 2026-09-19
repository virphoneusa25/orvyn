// scripts/acceptance-mission.mjs
//
// Acceptance harness for the mission pipeline. Starts a real mission through
// the Astra orchestrator, streams its events to stdout, and plays the role of
// the user by approving every tool call the runtime pauses on. Nothing here is
// mocked — it exercises the same HTTP API the desktop app uses.
//
// Usage:
//   node scripts/acceptance-mission.mjs <projectRoot> "<goal>" [--deny <toolName>] [--mission-scope]
//
// --deny makes the harness deny a specific tool once (to exercise the denial
// path); every other approval is granted.
// --mission-scope answers every approval with "Allow for Mission", so a
// second approval request for the same tool in the same run is a bug.

const API = process.env.ORVYN_API_URL ?? "http://localhost:4570/api/v1";
const TIMEOUT_MS = 15 * 60 * 1000;

const [projectRoot, goal, ...rest] = process.argv.slice(2);
if (!projectRoot || !goal) {
  console.error('usage: node scripts/acceptance-mission.mjs <projectRoot> "<goal>" [--deny <tool>]');
  process.exit(2);
}
let denyOnce = null;
const denyIdx = rest.indexOf("--deny");
if (denyIdx >= 0) denyOnce = rest[denyIdx + 1] ?? null;
const missionScope = rest.includes("--mission-scope");
const missionApproved = new Set();

const headers = { "Content-Type": "application/json" };
if (process.env.ORVYN_API_KEY) headers["Authorization"] = `Bearer ${process.env.ORVYN_API_KEY}`;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function summarize(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "message.delta":
      return String(d.content ?? "").replace(/\s+/g, " ").slice(0, 140);
    case "tool.started":
      return `${d.tool} (task ${d.taskId ?? "-"})`;
    case "tool.input":
      return JSON.stringify(d.input).slice(0, 160);
    case "tool.completed":
      return `${d.tool}: ${String(d.preview ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
    case "tool.failed":
      return `${d.tool}: ${d.error}`;
    case "approval.required":
      return `${d.tool} ${JSON.stringify(d.input).slice(0, 120)}`;
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}

const { runId } = await api("POST", "/agent/orchestrate", { projectRoot, goal });
console.log(`run ${runId} started against ${projectRoot}`);
console.log(`goal: ${goal}\n`);

const started = Date.now();
let after = 0;
let done = false;
let finalStatus = "unknown";

while (!done) {
  if (Date.now() - started > TIMEOUT_MS) {
    console.error("TIMEOUT: mission did not finish within the limit");
    process.exit(1);
  }
  const { status, events } = await api("GET", `/agent/stream/runs/${runId}/events.json?after=${after}`);
  for (const e of events) {
    after = Math.max(after, e.sequence);
    if (e.type === "message.delta" && !String(e.data?.content ?? "").trim()) continue;
    console.log(`${stamp()} [${String(e.type).padEnd(20)}] ${summarize(e)}`);

    if (e.type === "approval.required") {
      const tool = e.data?.tool;
      const destructive = e.data?.destructive === true;
      const approved = !(denyOnce && tool === denyOnce);
      if (!approved) denyOnce = null; // deny only the first occurrence
      const scope = missionScope && approved ? "mission" : "once";
      if (missionScope && approved && !destructive && missionApproved.has(tool)) {
        console.log(`${stamp()} [harness             ] BUG: re-prompted for mission-approved tool ${tool}`);
        process.exitCode = 1;
      }
      if (scope === "mission" && !destructive) missionApproved.add(tool);
      await api("POST", `/agent/orchestrate/approvals/${e.data.callId}`, { approved, scope });
      console.log(`${stamp()} [harness             ] ${approved ? `APPROVED (${scope})` : "DENIED"} ${tool}`);
    }
  }
  if (status === "completed" || status === "error") {
    finalStatus = status;
    done = true;
  } else {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log(`\nrun finished: ${finalStatus} (${Math.round((Date.now() - started) / 1000)}s)`);

const { missions } = await api("GET", "/missions");
const mission = missions.find((m) => m.runId === runId) ?? missions[0];
if (mission) {
  const detail = await api("GET", `/missions/${mission.id}`);
  console.log("\n--- mission ---");
  console.log(JSON.stringify(detail, null, 2));
}
process.exit(finalStatus === "completed" ? 0 : 1);
