#!/usr/bin/env node
// Shared-worker multi-tenant mission isolation probe.
const base = process.argv[2] || process.env.ORVYN_STAGING_URL || "https://staging.orvyn.virphoneusa.com";
const workerKey = process.argv[3] || process.env.ORVYN_API_KEY || "";
const suffix = Date.now().toString(36);
const password = "Isolation1!";

async function req(path, { method = "GET", token, body, key } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const a = await req("/auth/register", { method: "POST", body: { email: `msn-a-${suffix}@example.com`, password, name: "Mission A" } });
const b = await req("/auth/register", { method: "POST", body: { email: `msn-b-${suffix}@example.com`, password, name: "Mission B" } });
if (a.status !== 201 || b.status !== 201) {
  console.error("register failed", a.status, b.status);
  process.exit(1);
}

await req("/projects", { method: "POST", token: a.json.token, body: { name: "A mission project" } });
await req("/projects", { method: "POST", token: b.json.token, body: { name: "B mission project" } });

if (!workerKey) {
  console.log(JSON.stringify({
    ok: false,
    reason: "ORVYN_API_KEY required to exercise the shared worker queue",
    tenants: { a: a.json.principal.tenantId, b: b.json.principal.tenantId },
  }, null, 2));
  process.exit(2);
}

const workerId = `iso-worker-${suffix}`;
const reg = await req("/worker/register", {
  method: "POST",
  key: workerKey,
  body: {
    workerId,
    hostname: "isolation-probe",
    capabilities: ["docker", "mission-execution"],
    cpuCount: 2,
    ramMb: 2048,
    diskGb: 10,
    dockerVersion: "probe",
    status: "online",
    activeRuns: 0,
  },
});

const submitA = await req("/worker/submit", {
  method: "POST",
  key: workerKey,
  body: {
    instruction: "isolation A",
    tenantId: a.json.principal.tenantId,
    organizationId: a.json.principal.organizationId,
    userId: a.json.principal.userId,
    projectRoot: "/tmp/missing-a",
  },
});
const submitB = await req("/worker/submit", {
  method: "POST",
  key: workerKey,
  body: {
    instruction: "isolation B",
    tenantId: b.json.principal.tenantId,
    organizationId: b.json.principal.organizationId,
    userId: b.json.principal.userId,
    projectRoot: "/tmp/missing-b",
  },
});

const poll1 = await req(`/worker/poll?workerId=${encodeURIComponent(workerId)}`, { key: workerKey });
const poll2 = await req(`/worker/poll?workerId=${encodeURIComponent(workerId)}`, { key: workerKey });
const jobA = [poll1.json.job, poll2.json.job].find((j) => j && j.tenantId === a.json.principal.tenantId);
const jobB = [poll1.json.job, poll2.json.job].find((j) => j && j.tenantId === b.json.principal.tenantId);

const stealCancel = jobA
  ? await req(`/worker/cancel/${jobA.runId}`, { method: "POST", token: b.json.token, body: { tenantId: a.json.principal.tenantId } })
  : { status: 0, json: {} };
const stealEvents = jobA
  ? await req(`/agent/stream/runs/${jobA.runId}/events.json`, { token: b.json.token })
  : { status: 0, json: {} };

const workspaces = [jobA?.workspace, jobB?.workspace].filter(Boolean);
const isolatedWorkspaces =
  Boolean(jobA && jobB) &&
  jobA.workspace !== jobB.workspace &&
  String(jobA.workspace).includes(a.json.principal.tenantId) &&
  String(jobB.workspace).includes(b.json.principal.tenantId) &&
  !String(jobA.workspace).includes(b.json.principal.tenantId);

const ok =
  reg.status === 200 &&
  submitA.status === 201 &&
  submitB.status === 201 &&
  isolatedWorkspaces &&
  (stealCancel.status === 403 || stealCancel.status === 404) &&
  (stealEvents.status === 404 || stealEvents.status === 403 || !stealEvents.json?.run);

console.log(JSON.stringify({
  ok,
  tenants: { a: a.json.principal.tenantId, b: b.json.principal.tenantId },
  runIds: { a: submitA.json.runId, b: submitB.json.runId },
  workspaces,
  isolatedWorkspaces,
  stealCancel: stealCancel.status,
  stealEvents: stealEvents.status,
  pollTenants: [poll1.json.job?.tenantId, poll2.json.job?.tenantId],
}, null, 2));
process.exit(ok ? 0 : 1);
