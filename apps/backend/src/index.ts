import "./loadEnv";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v1Router } from "./routes/v1";
import { authRouter } from "./routes/auth";
import { resolveTenant, resolveTenantFromToken } from "./middleware/tenant";
import { tenantRateLimit, ipRateLimit } from "./middleware/rateLimit";
import { tenantManager, bootstrapDefaultTenant } from "./tenancy/TenantManager";
import { Orchestrator } from "./ai/Orchestrator";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Unauthenticated: needed for container/load-balancer health probes.
// The simple form stays fast for Docker healthchecks; /api/v1/health/detailed
// probes the control-plane services (PostgreSQL, Redis) when configured.
app.get("/api/v1/health", (_req, res) =>
  res.json({ status: "ok", service: "orvyn-backend", version: "0.2.0" })
);

app.get("/api/v1/health/detailed", async (_req, res) => {
  const checks: Record<string, { healthy: boolean; detail?: string }> = {
    api: { healthy: true },
  };

  // PostgreSQL (when ORVYN_PG_URL is set — control-plane deployments)
  if (process.env.ORVYN_PG_URL) {
    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.ORVYN_PG_URL, connectionTimeoutMillis: 3000 });
      await client.connect();
      const r = await client.query("SELECT version()");
      await client.end();
      checks.postgres = { healthy: true, detail: r.rows[0]?.version?.split(" ").slice(0, 2).join(" ") };
    } catch (err: any) {
      checks.postgres = { healthy: false, detail: err.message };
    }
  } else {
    checks.postgres = { healthy: true, detail: "not configured (local mode)" };
  }

  // Redis (when ORVYN_REDIS_URL is set)
  if (process.env.ORVYN_REDIS_URL) {
    try {
      const net = await import("net");
      const url = new URL(process.env.ORVYN_REDIS_URL);
      const ok = await new Promise<boolean>((resolve) => {
        const sock = net.connect(Number(url.port || 6379), url.hostname);
        sock.setTimeout(2000);
        sock.on("connect", () => { sock.destroy(); resolve(true); });
        sock.on("error", () => resolve(false));
        sock.on("timeout", () => { sock.destroy(); resolve(false); });
      });
      checks.redis = { healthy: ok, detail: ok ? undefined : "connection refused" };
    } catch (err: any) {
      checks.redis = { healthy: false, detail: err.message };
    }
  } else {
    checks.redis = { healthy: true, detail: "not configured (local mode)" };
  }

  // Worker count (0 is valid — workers are Phase 4)
  checks.workers = { healthy: true, detail: "0 workers (Phase 4)" };

  const allHealthy = Object.values(checks).every((c) => c.healthy);
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    service: "orvyn-backend",
    version: "0.2.0",
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Accounts: register/login are reachable without credentials by design;
// me/logout validate their own bearer token against the session store.
// Per-IP rate limit so the open endpoints can't be hammered.
app.use("/api/v1/auth", ipRateLimit(), authRouter);

// Everything else resolves a tenant first — from a user session token or an
// API key. Each tenant has its own models, index, tools and agent sessions.
// The rate limit is per tenant, so one customer can't starve the others.
app.use("/api/v1", resolveTenant, tenantRateLimit(), v1Router);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/chat", maxPayload: 20 * 1024 * 1024 });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "", "http://internal");
  const token = url.searchParams.get("token");
  let tenant = resolveTenantFromToken(token);

  // If API keys are registered, a valid token is mandatory on the socket too —
  // otherwise the WS would be an unauthenticated bypass around the REST auth.
  if (tenantManager.hasRegisteredKeys() && !tenant) {
    socket.send(JSON.stringify({ delta: "", done: true, error: "Unauthorized — missing or invalid token" }));
    socket.close();
    return;
  }
  if (!tenant) tenant = tenantManager.ensureLocalDefault();

  socket.send(JSON.stringify({ type: "connection.ready", service: "orvyn-backend", at: Date.now() }));

  socket.on("message", async (raw) => {
    let body;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ delta: "", done: true, error: "Invalid JSON" }));
      return;
    }

    if (!tenant) {
      socket.send(JSON.stringify({ delta: "", done: true, error: "No tenant context" }));
      return;
    }

    try {
      const orchestrator = new Orchestrator(tenant.modelService, tenant.indexService);
      const rawSocket = (socket as any)._socket;
      if (rawSocket?.setNoDelay) rawSocket.setNoDelay(true);
      for await (const chunk of orchestrator.streamChat(body)) {
        socket.send(JSON.stringify(chunk));
        if (chunk.done) break;
        // Yield so each token can leave the process and paint in the UI
        // instead of arriving as one burst.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err: any) {
      socket.send(JSON.stringify({ delta: "", done: true, error: err.message }));
    }
  });
});

// Liveness heartbeat for desktop/cloud clients. A half-open socket must not
// leave the UI claiming the OVH execution host is Online.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as any;
    if (ws.readyState !== 1) continue;
    if (ws.__orvynAlive === false) { ws.terminate(); continue; }
    ws.__orvynAlive = false;
    ws.ping();
    ws.once("pong", () => { ws.__orvynAlive = true; });
  }
}, 15_000);
heartbeat.unref?.();
server.on("close", () => clearInterval(heartbeat));

const PORT = process.env.PORT ? Number(process.env.PORT) : 4570;
bootstrapDefaultTenant();
// Reconnect enabled MCP servers (best-effort; failures stay per-server).
setTimeout(() => {
  void (async () => { try { const t = tenantManager.ensureLocalDefault(); await t.mcpManager.startEnabled(); } catch {} })();
}, 3000);

server.listen(PORT, () => {
  console.log(`ORVYN backend listening on http://localhost:${PORT}`);
  console.log(`  REST:      http://localhost:${PORT}/api/v1/health`);
  console.log(`  WS stream: ws://localhost:${PORT}/ws/chat`);
  if (tenantManager.hasRegisteredKeys()) {
    console.log(`  Tenant "default" seeded from ORVYN_API_KEY.`);
  } else {
    console.warn(
      "\n⚠️  ORVYN_API_KEY is not set — the API is UNAUTHENTICATED and running\n" +
        "   single-tenant. Fine for local development only. Set ORVYN_API_KEY\n" +
        "   before exposing this to any network.\n"
    );
  }
});
