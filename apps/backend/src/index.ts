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
app.get("/api/v1/health", (_req, res) =>
  res.json({ status: "ok", service: "orvyn-backend", version: "0.2.0" })
);

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

const PORT = process.env.PORT ? Number(process.env.PORT) : 4570;
bootstrapDefaultTenant();

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
