// apps/backend/src/index.ts
import "./loadEnv";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v1Router, orchestrator } from "./routes/v1";
import { apiKeyAuth, wsAuthorized } from "./middleware/auth";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check stays unauthenticated (needed for load balancer / container
// health probes); everything else requires the API key when one is set.
app.get("/api/v1/health", (_req, res) => res.json({ status: "ok", service: "orvyn-backend", version: "0.1.0" }));
app.use("/api/v1", apiKeyAuth, v1Router);

const server = createServer(app);

// Streaming chat over WebSocket: client sends a ChatTurnRequest JSON blob,
// server streams back { delta, done } chunks. SSE is an equally valid
// alternative (see docs/architecture.md) — WS was chosen here because the
// desktop client also uses it for tool-approval round-trips.
const wss = new WebSocketServer({ server, path: "/ws/chat" });

wss.on("connection", (socket, req) => {
  if (!wsAuthorized(req)) {
    socket.send(JSON.stringify({ delta: "", done: true, error: "Unauthorized — missing or invalid token" }));
    socket.close();
    return;
  }

  socket.on("message", async (raw) => {
    let req;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ delta: "", done: true, error: "Invalid JSON" }));
      return;
    }

    try {
      for await (const chunk of orchestrator.streamChat(req)) {
        socket.send(JSON.stringify(chunk));
        if (chunk.done) break;
      }
    } catch (err: any) {
      socket.send(JSON.stringify({ delta: "", done: true, error: err.message }));
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4570;
server.listen(PORT, () => {
  console.log(`ORVYN backend listening on http://localhost:${PORT}`);
  console.log(`  REST:      http://localhost:${PORT}/api/v1/health`);
  console.log(`  WS stream: ws://localhost:${PORT}/ws/chat`);
  if (!process.env.ORVYN_API_KEY) {
    console.warn(
      "\n⚠️  ORVYN_API_KEY is not set — the API is UNAUTHENTICATED.\n" +
        "   This is fine for local development only. Before deploying to a\n" +
        "   cloud server or any network reachable by others, set ORVYN_API_KEY\n" +
        "   and put this behind HTTPS (see docs/DEPLOYMENT.md).\n"
    );
  }
});
