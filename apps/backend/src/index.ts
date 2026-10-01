import * as pathModule from "path";
import * as fsModule from "fs";
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
import { v1Router, isolateUntrustedContent } from "./routes/v1";
import { adminRouter } from "./routes/admin";
import { adminHost, appHost, onAdminHost, originFor } from "./http/hosts";
import { resolvePreviewLink } from "./artifacts/previewLinks";
import { siteRouter } from "./routes/sites";
import { portForwardingService } from "./ports/PortForwardingService";
import { workerStats } from "./routes/worker";
import { probeQdrant } from "./indexing/qdrantHealth";
import { authRouter } from "./routes/auth";
import { onboardingRouter } from "./routes/onboarding";
import { authorizeSocket, resolveTenant } from "./middleware/tenant";
import { requireAccountReady, socketAccountReady } from "./middleware/accountReady";
import { authService } from "./auth/AuthService";
import { redactChunk } from "./middleware/customerRedaction";
import { billingReturnRouter, stripeWebhookHandler } from "./routes/billingPublic";
import { tenantRateLimit, ipRateLimit } from "./middleware/rateLimit";
import { tenantManager, bootstrapDefaultTenant } from "./tenancy/TenantManager";
import { Orchestrator } from "./ai/Orchestrator";
import { chatCapabilityPrompt } from "./agent/runCapabilities";
import { environmentName } from "./identity/principal";
import { loadVaultKey } from "./secrets/vault";
import { githubToken } from "./integrations/githubConnection";
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
// Stripe signs the raw body: the webhook reads it before the JSON parser.
app.post("/api/v1/billing/stripe/webhook", ...stripeWebhookHandler);
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

  // Workers — cloud execution is degraded when no worker can take a mission.
  // Local desktop mode does not require the remote worker service.
  const ws = workerStats();
  checks.workers = {
    healthy: process.env.ORVYN_CLOUD_MODE !== "true" || ws.online > 0,
    detail: `${ws.online}/${ws.total} online`,
  };

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
// The portal's preview frame: one stored file by a five-minute link (no session), sandboxed.
app.get("/api/v1/preview/:token", async (req, res) => {
  const link = resolvePreviewLink(String(req.params.token));
  const tenant = link ? tenantManager.get(link.tenantId) : undefined;
  if (!link || !tenant) return res.status(404).type("text/plain").send("This preview link expired. Open the preview again.");
  try {
    const { record, bytes, filename } = await tenant.artifactService.previewArtifact(link.artifactId);
    isolateUntrustedContent(res, record.mimeType || "");
    if (/html|svg|xml/i.test(record.mimeType || "")) res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals; default-src 'self' data: blob: 'unsafe-inline'; frame-ancestors 'self'");
    else res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch {
    res.status(404).type("text/plain").send("That file is no longer available.");
  }
});
app.use("/api/v1/billing/return", billingReturnRouter);
// ORVYN Admin Portal API: platform staff only (checked inside), never the customer chain.
app.use("/api/v1/admin", ipRateLimit(Number(process.env.ORVYN_ADMIN_RATE_LIMIT_RPM) || 600), adminRouter);
// Credential endpoints (sign-up, sign-in, reset, provider starts) get the
// strict per-IP limit; session reads and the desktop's sign-in polling a
// looser one, so an app waiting for the browser never trips the limiter.
const strictAuthLimit = ipRateLimit();
const sessionAuthLimit = ipRateLimit(Number(process.env.ORVYN_AUTH_SESSION_RATE_LIMIT_RPM) || 300);
const CREDENTIAL_PATHS = /^\/(register|login|password\/|verification\/(resend|change-email)|oauth\/[^/]+\/start)/;
app.use("/api/v1/auth", (req, res, next) => (CREDENTIAL_PATHS.test(req.path) ? strictAuthLimit : sessionAuthLimit)(req, res, next), authRouter);
// Onboarding is signed in and saves every screen (plus analytics): a person
// clicking through quickly must never hit the sign-in brute-force limit.
app.use("/api/v1/onboarding", ipRateLimit(Number(process.env.ORVYN_ONBOARDING_RATE_LIMIT_RPM) || 240), onboardingRouter);

// A shared conversation (read-only public link from Chats → Share). Text only:
// attachments, files and account details never leave through a share link.
app.get("/api/v1/public/shares/:token", ipRateLimit(120), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const share = authService.resolveShare(String(req.params.token));
  const as = share ? authService.principalFor(share.userId, share.organizationId) : null;
  const tenant = as ? tenantManager.ensureOrgTenant(as.principal) : null;
  const session = share && tenant ? tenant.sessions.get(share.sessionId) : undefined;
  if (!share || !session || (session.userId && session.userId !== share.userId)) return res.status(404).json({ error: "This shared conversation isn't available. The link may have been turned off." });
  const messages = tenant!.sessions.messages(session.sessionId, 0)
    .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
    .map((m: { role: string; content: string; createdAt: number }) => ({ role: m.role, content: String(m.content ?? ""), createdAt: m.createdAt }));
  res.json({ title: session.title, sharedAt: share.createdAt, author: as!.user.name?.split(" ")[0] ?? null, messages });
});

// Everything else resolves a tenant first — from a user session token or an
// API key. Each tenant has its own models, index, tools and agent sessions.
// The rate limit is per tenant, so one customer can't starve the others.
// …then the account gate: a signed-in person uses ORVYN only after verifying
// their email and finishing onboarding (no skipping into the app).
app.use("/api/v1", resolveTenant, requireAccountReady, (req, res, next) => {
    // Desktop frame polling is a real-time visual stream (~11 FPS), not a
    // typical API call — exempting it prevents the 300 RPM tenant limiter
    // from starving the stream with 429s while the user watches.
    if (req.path.startsWith("/desktop/frame")) return next();
    return tenantRateLimit()(req, res, next);
  }, v1Router);

// ORVYN Cloud — the customer portal (apps/web), on the same origin as the API.
// Static files, then the app shell for any page path (client-side routing).
// Strict CSP: scripts only from this origin; nothing may frame the portal.
const WEB_DIR = [process.env.ORVYN_WEB_DIR, pathModule.resolve(__dirname, "../web"), pathModule.resolve(__dirname, "../../web/dist")]
  .find((d) => d && fsModule.existsSync(pathModule.join(d, "index.html")));
if (WEB_DIR) {
  const PORTAL_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
  ].join("; ");
  const secure = (res: express.Response) => {
    res.setHeader("Content-Security-Policy", PORTAL_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
  };
  app.use(express.static(WEB_DIR, {
    index: false,
    setHeaders: (res, file) => {
      secure(res);
      res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  }));
  const shell = fsModule.readFileSync(pathModule.join(WEB_DIR, "index.html"), "utf8");
  // The same app serves the customer portal and the Admin Portal; the host decides (http/hosts.ts).
  const shellFor = (surface: "app" | "admin") => shell.replace("<head>", `<head>
    <meta name="orvyn-surface" content="${surface}" />
    <meta name="orvyn-app-host" content="${appHost() ?? ""}" />
    <meta name="orvyn-admin-host" content="${adminHost() ?? ""}" />${surface === "admin" ? '\n    <meta name="robots" content="noindex, nofollow" />' : ""}`);
  app.get(/^\/(?!api\/|ws\/).*/, (req, res) => {
    const admin = onAdminHost(req);
    // /admin on the customer host moves to the admin host.
    if (!admin && adminHost() && /^\/admin(\/|$)/.test(req.path)) return res.redirect(302, `${originFor(req, adminHost()!)}${req.originalUrl}`);
    secure(res);
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(shellFor(admin ? "admin" : "app"));
  });
}

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
  const ticket = url.searchParams.get("ticket");
  const token = ticket ? authService.redeemWsTicket(ticket) : url.searchParams.get("token");
  if (ticket && !token) {
    socket.send(JSON.stringify({ delta: "", done: true, error: "This connection expired. Reconnecting…", code: "TICKET_EXPIRED" }));
    socket.close();
    return;
  }
  const ready = socketAccountReady(token);
  if (!ready.ok) {
    socket.send(JSON.stringify({ delta: "", done: true, error: ready.error, code: ready.code }));
    socket.close();
    return;
  }
  const admitted = authorizeSocket(token);
  if (!admitted.ok) {
    socket.send(JSON.stringify({ delta: "", done: true, error: admitted.error }));
    socket.close();
    return;
  }
  const tenant = admitted.tenant;
  (socket as any).__orvynTenantId = tenant.id;
  // The person on this socket (session tokens): conversations are theirs alone.
  const socketUserId = token ? authService.verifyPrincipal(token)?.user.id ?? null : null;

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
          // The chat has no per-tool approval UI: its own tool set is
          // internally sanctioned. Flat "denied" still blocks at the registry.
          const approval = { granted: true, scope: "internal", grantedBy: "runtime" } as const;
          if (tenant.toolGateway.list().some((t) => t.name === name)) return tenant.toolGateway.execute(name, args, undefined, { approval });
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
      const found = typeof body?.sessionId === "string" ? tenant.sessions.get(body.sessionId) : undefined;
      if (found && socketUserId && found.userId && found.userId !== socketUserId) {
        socket.send(JSON.stringify({ delta: "", done: true, error: "Unknown conversation" }));
        return;
      }
      const session = found;
      // ORVYN Cloud (the web portal) is a conversation, never a mission: no
      // project task handoff, and the history comes from the stored
      // conversation rather than from the client.
      const cloudSurface = body?.surface === "cloud";
      if (cloudSurface) {
        body.surface = "cloud";
        body.sessionId = session?.sessionId;
        if (session && !Array.isArray(body.history)) {
          body.history = tenant.sessions.messages(session.sessionId)
            .filter((m) => (m.role === "user" || m.role === "assistant") && m.status === "complete" && m.content.trim())
            .slice(-24)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 12_000) }));
        }
        if (!Array.isArray(body.history)) body.history = [];
        body.task = "chat";
        if (body.context && typeof body.context === "object") delete body.context.projectRoot;
      }
      // Regenerate: the old reply is replaced by the one about to stream.
      if (session && typeof body?.replacesMessageId === "string") tenant.sessions.deleteMessage(session.sessionId, body.replacesMessageId);
      recorder = session && typeof body?.userMessage === "string"
        ? new ChatTurnRecorder(tenant.sessions, session.sessionId, {
            userMessage: body.userMessage,
            userMessageId: typeof body.userMessageId === "string" ? body.userMessageId : undefined,
            assistantMessageId: typeof body.assistantMessageId === "string" ? body.assistantMessageId : undefined,
            userCreatedAt: Number(body.userCreatedAt) || undefined,
            attachments: Array.isArray(body.attachmentRefs) ? body.attachmentRefs.slice(0, 20).map((a: any) => ({ artifactId: String(a?.artifactId ?? ""), name: String(a?.name ?? ""), mimeType: String(a?.mimeType ?? "") })).filter((a: any) => a.artifactId) : undefined,
          })
        : null;
      // A turn never hangs: a heartbeat every 10s tells the desktop the turn is
      // alive (a reasoning model can think silently for a while), and if the
      // model sends nothing for CHAT_STALL_MS the turn ends with a plain error
      // and a Retry — never an endless "ORION is thinking…".
      const stallMs = Number(process.env.ORVYN_CHAT_STALL_MS) || 150_000;
      const beat = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ delta: "", heartbeat: true, done: false })); }, 10_000);
      beat.unref?.();
      let stalled = false;
      const iterator = orchestrator.streamChat({ ...body, capabilityPrompt })[Symbol.asyncIterator]();
      const guarded = {
        [Symbol.asyncIterator]() { return this; },
        async next(): Promise<IteratorResult<any>> {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stall = new Promise<IteratorResult<any>>((resolve) => { timer = setTimeout(() => { stalled = true; resolve({ done: false, value: { delta: "", done: true, error: "ORION stopped responding — the model sent nothing for a while. Retry the message." } }); }, stallMs); });
          try { return await Promise.race([iterator.next(), stall]); } finally { clearTimeout(timer); }
        },
      };
      try {
      for await (const chunk of guarded) {
        socket.send(JSON.stringify(redactChunk(tenant, chunk)));
        const chunkError = (chunk as { error?: unknown }).error;
        if (chunk.activity) recorder?.activity(chunk.activity);
        if (Array.isArray((chunk as { artifacts?: unknown[] }).artifacts)) recorder?.artifacts((chunk as { artifacts: unknown[] }).artifacts);
        if (chunk.retract) recorder?.retract();
        if (chunkError) recorder?.finish(String(chunkError));
        else recorder?.delta(String(chunk.delta ?? ""));
        if (chunk.done) { recorder?.finish(); learn(); break; }
        // Yield so each token can leave the process and paint in the UI
        // instead of arriving as one burst.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      } finally {
        clearInterval(beat);
        if (stalled) { console.warn(JSON.stringify({ event: "chat.turn.stalled", stallMs })); void iterator.return?.(undefined).catch(() => undefined); }
      }
      recorder?.finish();
    } catch (err: any) {
      recorder?.finish(err.message);
      // A wallet/plan stop carries its code so the client can offer an upgrade or top-up.
      const code = (err as { billing?: boolean; code?: string })?.billing ? `CREDITS_${(err as { code?: string }).code ?? "LIMIT"}` : undefined;
      socket.send(JSON.stringify(redactChunk(tenant, { delta: "", done: true, error: err.message, ...(code ? { code } : {}) })));
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
    case "search_capabilities": return makeSearchCapabilitiesTool(market, { githubToken: () => githubToken(tenant.id) });
    case "install_mcp_server": return makeInstallMcpServerTool(market, { githubToken: () => githubToken(tenant.id) });
    default: return null;
  }
}
