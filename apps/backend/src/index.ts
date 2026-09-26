import "./loadEnv";
import { makeFetchUrlTool, makeWebSearchTool } from "./ai/tools/netTools";
import { makeInstallMcpServerTool, makeSearchCapabilitiesTool } from "./ai/tools/searchCapabilities";
import { marketplaceFor as chatMarketplaceFor } from "./mcp/marketplace/service";
import { learnFromUserMessage, type MemoryStoreLike } from "./memory/userMemory";
import { memoryModel } from "./memory/learnModel";
import { ChatTurnRecorder } from "./sessions/sessionMessages";
import express from "express";
import { cloudCors } from "./http/corsPolicy";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v1Router } from "./routes/v1";
import { siteRouter } from "./routes/sites";
import { portForwardingService } from "./ports/PortForwardingService";
import { workerStats } from "./routes/worker";
import { probeQdrant } from "./indexing/qdrantHealth";
import { authRouter } from "./routes/auth";
import { authorizeSocket, resolveTenant } from "./middleware/tenant";
import { tenantRateLimit, ipRateLimit } from "./middleware/rateLimit";
import { tenantManager, bootstrapDefaultTenant } from "./tenancy/TenantManager";
import { Orchestrator } from "./ai/Orchestrator";
import { chatCapabilityPrompt } from "./agent/runCapabilities";
import { environmentName } from "./identity/principal";
import { loadVaultKey } from "./secrets/vault";
import { migratePostgresIdentity } from "./identity/postgres";
import { redisHealth } from "./identity/redisNamespace";
import { readFileSync } from "fs";
import { join } from "path";

/** Which commit this server runs (written by scripts/deploy-ovh.sh). */
const BUILD_INFO: { commit?: string; builtAt?: string } = (() => {
  if (process.env.ORVYN_BUILD_SHA) return { commit: process.env.ORVYN_BUILD_SHA };
  for (const file of [join(process.cwd(), "build-info.json"), join(__dirname, "..", "build-info.json")]) {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* try next */ }
  }
  return {};
})();

const app = express();
app.use(cloudCors());
app.use(express.json({ limit: "10mb" }));

// Unauthenticated: needed for container/load-balancer health probes.
// The simple form stays fast for Docker healthchecks; /api/v1/health/detailed
// probes the control-plane services (PostgreSQL, Redis) when configured.

app.get("/api/v1/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "orvyn-backend",
    version: "0.2.0",
    commit: BUILD_INFO.commit ?? "unknown",
    builtAt: BUILD_INFO.builtAt,
    environment: environmentName(),
    artifactStorage: "healthy",
    marketplaceCatalogVersion: 1,
    supportedProviders: ["official", "glama", "smithery", "local", "private"],
    installApiVersion: 1,
  })
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

  checks.redis = await redisHealth();
  checks.identity = { healthy: true, detail: "session + personal organization" };

  if (process.env.ORVYN_PG_URL) {
    try {
      const migrated = await migratePostgresIdentity();
      checks.migrations = { healthy: true, detail: `${migrated.database} applied=${migrated.applied.join(",") || "none"}` };
    } catch (err: any) {
      checks.migrations = { healthy: false, detail: err.message };
    }
  } else {
    checks.migrations = { healthy: true, detail: "sqlite identity (local mode)" };
  }

  // Workers — the real registry count (0 registered is healthy but reported
  // honestly; forced-remote runs are refused while 0 are online).
  const ws = workerStats();
  checks.workers = { healthy: true, detail: `${ws.online}/${ws.total} online` };

  const qdrant = await probeQdrant();
  if (qdrant.status === "not_configured") {
    checks.qdrant = { healthy: true, detail: "not configured (local mode)" };
  } else {
    checks.qdrant = {
      healthy: qdrant.status === "healthy",
      detail: qdrant.status === "healthy"
        ? `${qdrant.version ?? "qdrant"} collections=${qdrant.collections ?? 0}`
        : qdrant.detail ?? "unreachable",
    };
  }

  try {
    const { defaultDataDir } = await import("./persistence/LocalStore");
    const { artifactStorageRoot } = await import("./documents/workspace");
    const { promises: fsp } = await import("fs");
    const { join } = await import("path");
    const root = artifactStorageRoot("health", defaultDataDir());
    await fsp.mkdir(root, { recursive: true });
    const probe = join(root, ".health");
    const stamp = String(Date.now());
    await fsp.writeFile(probe, stamp);
    const read = await fsp.readFile(probe, "utf-8");
    checks.artifacts = { healthy: read === stamp, detail: read === stamp ? "writable" : "readback mismatch" };
    checks.artifactStorage = checks.artifacts;
  } catch (err: any) {
    checks.artifacts = { healthy: false, detail: err?.message ?? "artifact storage unavailable" };
    checks.artifactStorage = checks.artifacts;
  }

  const allHealthy = Object.values(checks).every((c) => c.healthy);
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    service: "orvyn-backend",
    version: "0.2.0",
    environment: environmentName(),
    checks,
    qdrant: {
      status: qdrant.status === "not_configured" ? "not_configured" : qdrant.status,
      version: qdrant.version,
      reachable: qdrant.reachable,
      collections: qdrant.collections,
    },
    timestamp: new Date().toISOString(),
  });
});

// Accounts: register/login are reachable without credentials by design;
// me/logout validate their own bearer token against the session store.
// Per-IP rate limit so the open endpoints can't be hammered.
app.use("/api/v1/sites", siteRouter);
app.use("/api/v1/auth", ipRateLimit(), authRouter);

// Everything else resolves a tenant first — from a user session token or an
// API key. Each tenant has its own models, index, tools and agent sessions.
// The rate limit is per tenant, so one customer can't starve the others.
app.use("/api/v1", resolveTenant, (req, res, next) => {
    // Desktop frame polling is a real-time visual stream (~11 FPS), not a
    // typical API call — exempting it prevents the 300 RPM tenant limiter
    // from starving the stream with 429s while the user watches.
    if (req.path.startsWith("/desktop/frame")) return next();
    return tenantRateLimit()(req, res, next);
  }, v1Router);

const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://internal");
  const match = url.pathname.match(/^\/api\/v1\/ports\/([^/]+)\/proxy\/?$/);
  if (!match) return;
  try {
    const rec = portForwardingService.authorizeByToken(match[1], url.searchParams.get("fwd") ?? "");
    portForwardingService.proxyUpgrade(rec, req, socket, head);
  } catch {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});
const wss = new WebSocketServer({ server, path: "/ws/chat", maxPayload: 20 * 1024 * 1024 });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "", "http://internal");
  const token = url.searchParams.get("token");
  const admitted = authorizeSocket(token);
  if (!admitted.ok) {
    socket.send(JSON.stringify({ delta: "", done: true, error: admitted.error }));
    socket.close();
    return;
  }
  const tenant = admitted.tenant;
  (socket as any).__orvynTenantId = tenant.id;

  socket.send(JSON.stringify({
    type: "connection.ready",
    service: "orvyn-backend",
    tenantId: tenant.id,
    at: Date.now(),
  }));

  let recorder: ChatTurnRecorder | null = null;
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
    if (body?.tenantId && String(body.tenantId) !== tenant.id) {
      socket.send(JSON.stringify({ delta: "", done: true, error: "tenantId is resolved from the session, not the client" }));
      return;
    }

    try {
      const orchestrator = new Orchestrator(tenant.modelService, tenant.indexService, tenant.artifactService, tenant.localStore as unknown as MemoryStoreLike, {
        // The chat researches on its own: web_search / fetch_url through the tool gateway.
        // Before a project is opened the gateway has no tools yet; the chat's own tools still work.
        execute: (name, args) => {
          if (tenant.toolGateway.list().some((t) => t.name === name)) return tenant.toolGateway.execute(name, args);
          const own = chatOwnTool(tenant, name);
          return own ? own.execute(args, {} as any) : Promise.resolve({ ok: false, error: `Unknown tool "${name}"` });
        },
        // MCP servers the user installed (e.g. a search server ORION asked for) are the chat's tools too.
        mcpTools: () => tenant.toolGateway.list()
          .filter((t) => t.name.startsWith("mcp.") && tenant.toolGateway.getPermission?.(t.name) !== "denied")
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as any })),
      });
      // What the user says about themselves or their work is remembered for next time (best-effort, after the reply).
      const learn = () => { if (typeof body?.userMessage === "string") void learnFromUserMessage(tenant.localStore as unknown as MemoryStoreLike, memoryModel(tenant.modelService), body.userMessage); };
      const rawSocket = (socket as any)._socket;
      if (rawSocket?.setNoDelay) rawSocket.setNoDelay(true);
      const capabilityPrompt = chatCapabilityPrompt(tenant.toolGateway.list().map((t) => t.name));
      // The turn is stored now, and the reply as it streams: the session is
      // the durable conversation, not the desktop's cache file.
      const session = typeof body?.sessionId === "string" ? tenant.sessions.get(body.sessionId) : undefined;
      // Regenerate: the old reply is replaced by the one about to stream.
      if (session && typeof body?.replacesMessageId === "string") tenant.sessions.deleteMessage(session.sessionId, body.replacesMessageId);
      recorder = session && typeof body?.userMessage === "string"
        ? new ChatTurnRecorder(tenant.sessions, session.sessionId, {
            userMessage: body.userMessage,
            userMessageId: typeof body.userMessageId === "string" ? body.userMessageId : undefined,
            assistantMessageId: typeof body.assistantMessageId === "string" ? body.assistantMessageId : undefined,
            userCreatedAt: Number(body.userCreatedAt) || undefined,
          })
        : null;
      for await (const chunk of orchestrator.streamChat({ ...body, capabilityPrompt })) {
        socket.send(JSON.stringify(chunk));
        const chunkError = (chunk as { error?: unknown }).error;
        if (chunk.activity) recorder?.activity(chunk.activity);
        if (chunk.retract) recorder?.retract();
        if (chunkError) recorder?.finish(String(chunkError));
        else recorder?.delta(String(chunk.delta ?? ""));
        if (chunk.done) { recorder?.finish(); learn(); break; }
        // Yield so each token can leave the process and paint in the UI
        // instead of arriving as one burst.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      recorder?.finish();
    } catch (err: any) {
      recorder?.finish(err.message);
      socket.send(JSON.stringify({ delta: "", done: true, error: err.message }));
    }
  });
  // The app closed mid-reply: keep what arrived.
  socket.on("close", () => recorder?.finish());
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

try {
  loadVaultKey();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4570;
if (process.env.ORVYN_PG_URL) {
  void migratePostgresIdentity().catch((err) => {
    console.error("Postgres identity migration failed:", err?.message ?? err);
  });
}
bootstrapDefaultTenant();
// Reconnect enabled MCP servers (best-effort; failures stay per-server).
setTimeout(() => {
  void (async () => { try { const t = tenantManager.ensureLocalDefault(); await t.mcpManager.startEnabled(); } catch {} })();
}, 3000);

server.listen(PORT, () => {
  console.log(`ORVYN backend listening on http://localhost:${PORT}`);
  console.log(`  Fireworks configured: ${process.env.FIREWORKS_API_KEY?.trim() ? "yes" : "no"}`);
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

/** The chat's own tools (web search, page reads, finding and installing MCP tools), usable before any project is open. */
function chatOwnTool(tenant: any, name: string) {
  const market = () => chatMarketplaceFor(tenant.mcpManager, tenant.localStore, tenant.id);
  switch (name) {
    case "web_search": return makeWebSearchTool();
    case "fetch_url": return makeFetchUrlTool();
    case "search_capabilities": return makeSearchCapabilitiesTool(market);
    case "install_mcp_server": return makeInstallMcpServerTool(market);
    default: return null;
  }
}
