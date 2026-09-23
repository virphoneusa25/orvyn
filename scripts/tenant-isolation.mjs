#!/usr/bin/env node
// Two-tenant isolation probe against a live control plane.

const base = process.argv[2] || process.env.ORVYN_STAGING_URL || "https://staging.orvyn.virphoneusa.com";
const suffix = Date.now().toString(36);
const password = "Isolation1!";

async function req(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function wsUrl(token) {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/chat";
  u.search = token ? `token=${encodeURIComponent(token)}` : "";
  return u.toString();
}

function decodeWs(raw) {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return String(raw);
}

function openSocket(token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(token));
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("ws timeout"));
    }, timeoutMs);
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(decodeWs(event.data)); } catch { msg = { raw: decodeWs(event.data) }; }
      if (msg.type === "connection.ready" || msg.error || msg.done) {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    });
  });
}

function sendAndWait(ws, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws reply timeout")), timeoutMs);
    const onMsg = (event) => {
      let msg;
      try { msg = JSON.parse(decodeWs(event.data)); } catch { msg = { raw: decodeWs(event.data) }; }
      if (msg.type === "connection.ready") return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(msg);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify(body));
  });
}

const health = await req("/health");
const detailed = await req("/health/detailed");
if (health.status !== 200 || health.json.status !== "ok") {
  console.error("health failed", health);
  process.exit(1);
}

const a = await req("/auth/register", {
  method: "POST",
  body: { email: `iso-a-${suffix}@example.com`, password, name: "Tenant A" },
});
const b = await req("/auth/register", {
  method: "POST",
  body: { email: `iso-b-${suffix}@example.com`, password, name: "Tenant B" },
});
if (a.status !== 201 || b.status !== 201) {
  console.error("register failed", a, b);
  process.exit(1);
}

const loginA = await req("/auth/login", {
  method: "POST",
  body: { email: a.json.user.email, password },
});
const loginB = await req("/auth/login", {
  method: "POST",
  body: { email: b.json.user.email, password },
});
if (loginA.status !== 200 || loginB.status !== 200) {
  console.error("login failed", loginA, loginB);
  process.exit(1);
}

const tokenA = loginA.json.token;
const tokenB = loginB.json.token;
const pa = loginA.json.principal;
const pb = loginB.json.principal;

const projectA = await req("/projects", { method: "POST", token: tokenA, body: { name: "A project" } });
const chatA = await req("/chats", { method: "POST", token: tokenA, body: { title: "A chat" } });
const projectB = await req("/projects", { method: "POST", token: tokenB, body: { name: "B project" } });
const chatB = await req("/chats", { method: "POST", token: tokenB, body: { title: "B chat" } });

const listA = await req("/projects", { token: tokenA });
const listB = await req("/projects", { token: tokenB });
const stealProject = await req(`/projects/${projectA.json.project.id}`, { token: tokenB });
const stealChat = await req(`/chats/${chatA.json.chat.id}`, { token: tokenB });
const guess = await req("/projects/prj_does_not_exist", { token: tokenA });
const override = await req("/projects", {
  method: "POST",
  token: tokenA,
  body: { name: "hijack", tenantId: pb.tenantId },
});
const headerOverride = await fetch(`${base}/api/v1/projects`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${tokenA}`,
    "X-Tenant-Id": pb.tenantId,
  },
  body: JSON.stringify({ name: "header-hijack" }),
});

let wssTenant = null;
let wssOverride = null;
let wssUnauth = "rejected";
try {
  const sockA = await openSocket(tokenA);
  wssTenant = sockA.msg.tenantId;
  wssOverride = await sendAndWait(sockA.ws, { tenantId: pb.tenantId, messages: [{ role: "user", content: "no" }] });
  sockA.ws.close();
} catch (err) {
  wssOverride = { error: String(err?.message ?? err) };
}
try {
  const unauth = await openSocket(null, 4000);
  wssUnauth = unauth.msg.error ? "rejected" : "admitted";
  unauth.ws.close();
} catch {
  wssUnauth = "rejected";
}

const ok =
  stealProject.status === 404 &&
  stealChat.status === 404 &&
  guess.status === 404 &&
  override.status === 403 &&
  headerOverride.status === 403 &&
  pa.tenantId !== pb.tenantId &&
  pa.organizationId !== pb.organizationId &&
  listA.json.projects.every((p) => p.tenantId === pa.tenantId) &&
  listB.json.projects.every((p) => p.tenantId === pb.tenantId) &&
  !listA.json.projects.some((p) => p.id === projectB.json.project.id) &&
  !listB.json.projects.some((p) => p.id === projectA.json.project.id) &&
  wssTenant === pa.tenantId &&
  String(wssOverride?.error ?? "").includes("tenantId") &&
  wssUnauth === "rejected";

console.log(JSON.stringify({
  ok,
  health: health.json,
  detailed: {
    status: detailed.status,
    environment: detailed.json.environment,
    checks: detailed.json.checks,
  },
  tenants: { a: pa.tenantId, b: pb.tenantId },
  orgs: { a: pa.organizationId, b: pb.organizationId },
  login: { a: loginA.status, b: loginB.status },
  created: { projectA: projectA.status, chatA: chatA.status, projectB: projectB.status, chatB: chatB.status },
  stealProject: stealProject.status,
  stealChat: stealChat.status,
  guess: guess.status,
  tenantOverride: override.status,
  headerOverride: headerOverride.status,
  wss: { tenant: wssTenant, overrideError: wssOverride?.error ?? null, unauth: wssUnauth },
}, null, 2));
process.exit(ok ? 0 : 1);
