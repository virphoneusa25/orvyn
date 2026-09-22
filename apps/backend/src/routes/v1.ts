import { documentRouter } from "./documents";
import { mcpRouter } from "./mcp";
import { workerRouter, hasOnlineWorker } from "./worker";
import { resolveWorkspace } from "../documents/workspace";
// apps/backend/src/routes/v1.ts
import { Router } from "express";
import { requireTenant } from "../middleware/tenant";
import { tenantManager } from "../tenancy/TenantManager";
import { Orchestrator } from "../ai/Orchestrator";
import { InlineEditService } from "../edit/InlineEditService";
import { CompleteService } from "../edit/CompleteService";
import { ImageService } from "../images/ImageService";
import { MODES } from "../agent/modes";

export const v1Router = Router();
v1Router.use("/documents", documentRouter);
v1Router.use("/mcp", mcpRouter(requireTenant));
v1Router.use("/worker", workerRouter(requireTenant, (tenantId?: string) => {
  if (!tenantId) {
    if (process.env.ORVYN_CLOUD_MODE === "true") throw new Error("tenant required");
    return tenantManager.ensureLocalDefault().runStore;
  }
  const tenant = tenantManager.get(tenantId);
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  return tenant.runStore;
}));

// Validate every explicit project root before an endpoint uses it. A forced
// remote run (executionLocation=OVH_WORKER) is exempt: its projectRoot names
// a WORKER-side path the control plane cannot stat — the worker validates it
// truthfully at project transfer, and a missing project fails the run there.
v1Router.use(async (req, res, next) => {
  try {
    const forcedRemote = req.body?.executionLocation === "OVH_WORKER";
    if (!forcedRemote && req.body?.projectRoot !== undefined && req.body.projectRoot !== null) req.body.projectRoot = await resolveWorkspace(requireTenant(req), req.body.projectRoot);
    if (req.query.projectRoot !== undefined) req.query.projectRoot = await resolveWorkspace(requireTenant(req), req.query.projectRoot);
    if (req.method === "POST" && ["/agent/stream/runs", "/agent/orchestrate"].includes(req.path)) {
      const tenant = requireTenant(req);
      if (tenant.runStore.list().some(run => ["running", "queued", "awaiting_approval"].includes(run.status))) return res.status(409).json({error:"A task is already active. Stop it or wait before starting another."});
      if (!forcedRemote) req.body.projectRoot = await resolveWorkspace(tenant, req.body.projectRoot);
    }
    next();
  } catch (e: any) { res.status(400).json({error:e.message}); }
});

// Note: GET /api/v1/health is registered unauthenticated directly on the
// Express app in index.ts (before apiKeyAuth), not here.

// --- Models ---
v1Router.get("/models", (req, res) => {
  res.json({ models: requireTenant(req).modelService.list() });
});

v1Router.post("/models", (req, res) => {
  try {
    const t = requireTenant(req);
    const provider = t.modelService.addModel(req.body);
    t.localStore.saveModel(req.body);
    res.status(201).json({ model: provider.config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.put("/models/:id", (req, res) => {
  try {
    const t = requireTenant(req);
    const ms = t.modelService;
    ms.removeModel(req.params.id);
    const config = { ...req.body, id: req.params.id };
    const provider = ms.addModel(config);
    t.localStore.saveModel(config);
    res.json({ model: provider.config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.delete("/models/:id", (req, res) => {
  const t = requireTenant(req);
  t.modelService.removeModel(req.params.id);
  t.localStore.deleteModel(req.params.id);
  res.status(204).end();
});

v1Router.get("/models/health", async (req, res) => {
  res.json({ results: await requireTenant(req).modelService.healthCheckAll() });
});

// "Test Model" button: round-trips a tiny real prompt through the model
// (not just a health ping) and reports latency + a response snippet, so
// the user can confirm the model is actually reachable and answering.
v1Router.post("/models/:id/test", async (req, res) => {
  const provider = requireTenant(req).modelService.registry.get(req.params.id);
  if (!provider) return res.status(404).json({ error: `Unknown model "${req.params.id}"` });
  if (!provider.config.capabilities.chat && !provider.config.capabilities.code) {
    const start = Date.now();
    try {
      const health = await provider.healthCheck();
      return res.json({
        ok: health.status === "online",
        latencyMs: Date.now() - start,
        snippet: health.status === "online" ? "Reachable (embeddings / non-chat model)." : health.error,
        finishReason: "stop",
      });
    } catch (err: any) {
      return res.status(502).json({ ok: false, latencyMs: Date.now() - start, error: err.message });
    }
  }

  const start = Date.now();
  try {
    const response = await provider.generate({
      messages: [
        { role: "user", content: req.body.prompt || "Reply with a short confirmation that you are working." },
      ],
      maxOutputTokens: 64,
    });
    res.json({
      ok: true,
      latencyMs: Date.now() - start,
      snippet: response.content.slice(0, 300),
      finishReason: response.finishReason,
    });
  } catch (err: any) {
    res.status(502).json({ ok: false, latencyMs: Date.now() - start, error: err.message });
  }
});

// --- Routing (which model handles each task type) ---
import { requiredCapability } from "@orvyn/ai-core";

v1Router.get("/routing", (req, res) => {
  res.json({ overrides: requireTenant(req).modelService.router.getOverrides() });
});

v1Router.post("/routing", (req, res) => {
  const { task, modelId } = req.body;
  const ms2 = requireTenant(req);
  const provider = ms2.modelService.registry.get(modelId);
  if (!provider) {
    return res.status(400).json({ error: `Unknown model "${modelId}"` });
  }
  // A model that cannot serve the task would break every request for it —
  // reject at the door with the reason rather than letting it poison routing.
  const capability = requiredCapability(task);
  if (!provider.config.capabilities[capability]) {
    return res.status(400).json({
      error: `"${modelId}" cannot handle task "${task}" — it lacks the "${capability}" capability.`,
    });
  }
  ms2.modelService.router.setOverride(task, modelId);
  // Persist so a restart keeps the user's choices instead of reverting to
  // env defaults (which may point at a dead-credits provider).
  ms2.localStore.setSetting("routing", JSON.stringify(ms2.modelService.router.getOverrides()));
  res.json({ overrides: ms2.modelService.router.getOverrides() });
});

v1Router.delete("/routing/:task", (req, res) => {
  const ms3 = requireTenant(req).modelService;
  ms3.router.clearOverride(req.params.task as any);
  res.json({ overrides: ms3.router.getOverrides() });
});

// --- Codebase indexing / RAG ---
v1Router.post("/index/build", async (req, res) => {
  const t = requireTenant(req);
  t.usage.indexBuilds++;
  const stats = await t.indexService.build(req.body.projectRoot);
  if (stats.status === "error") return res.status(500).json({ stats });
  res.json({ stats });
});

v1Router.post("/index/watch", (req, res) => {
  const t = requireTenant(req);
  if (!req.body.projectRoot) return res.status(400).json({ error: "projectRoot required" });
  t.indexService.watch(req.body.projectRoot);
  res.json({ stats: t.indexService.getStats() });
});

v1Router.get("/index/status", (req, res) => {
  res.json({ stats: requireTenant(req).indexService.getStats() });
});

v1Router.post("/search/semantic", async (req, res) => {
  try {
    const hits = await requireTenant(req).indexService.search(req.body.query, req.body.topK ?? 5);
    res.json({ hits });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Composer (multi-file plan/apply) ---
import { ComposerService } from "../composer/ComposerService";


v1Router.post("/composer/plan", async (req, res) => {
  try {
    const plan = await new ComposerService(requireTenant(req).modelService).plan(req.body.projectRoot, req.body.instruction, req.body.rules);
    res.json({ plan });
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
});

v1Router.post("/composer/apply", async (req, res) => {
  try {
    const written = await new ComposerService(requireTenant(req).modelService).apply(req.body.projectRoot, req.body.files);
    res.json({ written });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Agent (tool-calling loop with approval pauses) ---
import { AgentService } from "../agent/AgentService";
import { registerProjectToolsFor } from "../ai/registerProjectTools";


function serializeSession(session: import("../agent/AgentService").AgentSession) {
  return {
    id: session.id,
    status: session.status,
    stepCount: session.stepCount,
    maxSteps: session.maxSteps,
    finalOutput: session.finalOutput,
    errorMessage: session.errorMessage,
    pendingToolCall: session.pendingToolCall,
    toolLog: session.toolLog,
  };
}

v1Router.post("/agent/runs", async (req, res) => {
  try {
    const ta = requireTenant(req);
    registerProjectToolsFor(ta, req.body.projectRoot);
    ta.usage.agentRuns++;
    const session = await new AgentService(ta.modelService, ta.toolRegistry, ta.agentSessions).start(req.body.projectRoot, req.body.instruction, req.body.rules);
    res.status(201).json({ session: serializeSession(session) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.get("/agent/runs/:id", (req, res) => {
  const session = requireTenant(req).agentSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json({ session: serializeSession(session) });
});

v1Router.post("/agent/runs/:id/approve", async (req, res) => {
  try {
    const tb = requireTenant(req);
    const session = await new AgentService(tb.modelService, tb.toolRegistry, tb.agentSessions).approve(req.params.id, req.body.approved === true);
    res.json({ session: serializeSession(session) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Tools ---
v1Router.get("/tools", async (req, res) => {
  try {
  const tt = requireTenant(req);
  const root = await resolveWorkspace(tt, req.query.projectRoot ?? tt.currentProjectRoot);
  // Ensure-without-clobber: re-registering for the same root keeps the user's
  // permission overrides (handled inside registerProjectToolsFor), so listing
  // tools never resets what the user configured.
  if (root && !tt.runStore.list().some(run => ["running", "queued", "awaiting_approval"].includes(run.status))) {
    registerProjectToolsFor(tt, root);
  }
  res.json({
    tools: tt.toolGateway.list().map((t) => ({
      name: t.name,
      description: t.description,
      permission: tt.toolGateway.getPermission(t.name),
      capabilities: tt.permissionEngine.capabilitiesOf(t.name),
    })),
    available: tt.toolGateway.list().length > 0,
  });
  } catch(e:any) { res.status(400).json({error:e.message}); }
});

v1Router.post("/tools/:name/permission", (req, res) => {
  const t = requireTenant(req);
  t.toolRegistry.setPermission(req.params.name, req.body.permission);
  // Explicit user choice — persist per project so it survives restarts.
  if (t.currentProjectRoot) {
    t.localStore.setToolOverride(t.currentProjectRoot, req.params.name, req.body.permission);
  }
  res.json({ ok: true });
});

v1Router.post("/tools/:name/execute", async (req, res) => {
  const tr = requireTenant(req).toolRegistry;
  const permission = tr.getPermission(req.params.name);
  if (permission === "ask" && req.body.approved !== true) {
    return res.status(428).json({ error: "Approval required", requiresApproval: true });
  }
  const result = await tr.execute(req.params.name, req.body.args ?? {});
  res.json(result);
});

// --- Inline edit (Ctrl+K) ---
v1Router.post("/edit/inline", async (req, res) => {
  try {
    const result = await new InlineEditService(requireTenant(req).modelService).edit(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/complete", async (req, res) => {
  try {
    const result = await new CompleteService(requireTenant(req).modelService).complete(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/images/generate", async (req, res) => {
  try {
    const result = await new ImageService(requireTenant(req).modelService).generate(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Chat (non-streaming; use WS /ws/chat for streaming) ---
v1Router.post("/chat/completions", async (req, res) => {
  try {
    const tc = requireTenant(req);
    const response = await new Orchestrator(tc.modelService, tc.indexService).chat({
      task: req.body.task ?? "chat",
      history: req.body.history ?? [],
      userMessage: req.body.message,
      context: req.body.context,
    });
    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



// --- Streaming agent runs (typed event protocol) ---
import { registerProjectToolsFor as _regTools } from "../ai/registerProjectTools";
import { isTerminal } from "../agent/events";
import { loadSshHosts } from "../ai/tools/sshTools";

// Start a run. Returns a runId immediately; the client then opens the SSE
// stream below. Kept separate from the stream so a dropped connection never
// aborts the run itself.
v1Router.post("/agent/stream/runs", (req, res) => {
  const t = requireTenant(req);

  // Remote execution is EXPLICIT and has NO local fallback: if no worker is
  // online, the run is refused rather than silently executed locally.
  const requestedLocation = req.body.executionLocation === "OVH_WORKER" ? "OVH_WORKER" : "LOCAL";
  let remoteProjectRoot: string | undefined;
  if (requestedLocation === "OVH_WORKER") {
    remoteProjectRoot = String(req.body.remoteProjectRoot ?? req.body.projectRoot ?? "");
    if (!remoteProjectRoot) {
      return res.status(400).json({ error: "executionLocation=OVH_WORKER requires remoteProjectRoot (the worker-side project path)." });
    }
    if (!hasOnlineWorker()) {
      return res.status(409).json({ error: "No OVH worker is online — remote run refused. There is no local fallback for forced remote execution." });
    }
  }

  _regTools(t, req.body.projectRoot);
  t.usage.agentRuns++;
  const previous = typeof req.body.previousRunId === "string" ? t.runStore.get(req.body.previousRunId) : undefined;
  const history: {role: "user" | "assistant";content:string}[] = previous ? [{role:"user",content:String(previous.events.find(e=>e.type === "run.started")?.data.instruction ?? "").slice(0,4000)}, {role:"assistant",content:previous.events.filter(e=>e.type === "message.delta").map(e=>String(e.data.content ?? "")).join("").slice(-16000)}] : [];
  const runId = t.agentRuntime.start(
    req.body.projectRoot,
    req.body.instruction,
    req.body.rules,
    req.body.mode ?? "agent",
    req.body.attachments,
    history,
    typeof req.body.requestedModelId === "string" ? req.body.requestedModelId : undefined,
    requestedLocation === "OVH_WORKER" ? { location: "OVH_WORKER", remoteProjectRoot, tenantId: t.id } : undefined
  );
  res.status(201).json({ runId, executionLocation: requestedLocation });
});

// List runs (newest first) so panels like Agent Activity and Review can find
// the latest run without holding their own state.
v1Router.get("/agent/stream/runs", (req, res) => {
  const t = requireTenant(req);
  res.json({
    runs: t.runStore
      .list()
      .map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt,
        projectRoot: r.projectRoot,
        eventCount: r.events.length,
        usage: r.usage,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50),
  });
});

// Subscribe to a run's events over SSE. `?after=N` replays everything the
// client missed before attaching live — this is the reconnect path.
v1Router.get("/agent/stream/runs/:id/events", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });

  const after = req.query.after ? Number(req.query.after) : 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay missed events first, in order, so the client's view is contiguous.
  for (const e of t.runStore.eventsAfter(req.params.id, after)) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  // If the run already finished, close rather than holding the socket open.
  if (isTerminal(run.status)) {
    res.end();
    return;
  }

  // Heartbeat: an SSE comment every 15s keeps proxies from idling the
  // connection out and lets the client distinguish "stream alive, no events
  // yet" from "connection dead" (EventSource auto-reconnects the latter).
  const heartbeat = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      /* socket already gone — cleaned up below */
    }
  }, 15000);

  const unsubscribe = t.runStore.subscribe(req.params.id, (e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === "run.completed" || e.type === "run.error" || e.type === "run.cancelled") res.end();
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---- Durable ordered queue: follow-up instructions during a run ----------

// Queue a follow-up instruction
v1Router.post("/agent/stream/runs/:id/queue", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  if (run.status === "completed" || run.status === "error" || run.status === "cancelled") {
    return res.status(409).json({ error: "Run is finished — queue a new run instead." });
  }
  const item = t.runStore.queueAdd(req.params.id, String(req.body.text ?? ""));
  if (!item) return res.status(400).json({ error: "text required" });
  res.status(201).json({ item });
});

// List queued items (ordered by position)
v1Router.get("/agent/stream/runs/:id/queue", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  res.json({ items: t.runStore.queueList(req.params.id) });
});

// Reorder queue items (atomic position update)
v1Router.patch("/agent/stream/runs/:id/queue/reorder", (req, res) => {
  const t = requireTenant(req);
  const ok = t.runStore.queueReorder(req.params.id, Array.isArray(req.body.order) ? req.body.order.map(String) : []);
  if (!ok) return res.status(400).json({ error: "Invalid order array" });
  res.json({ ok: true });
});

// Edit a queued item's text
v1Router.patch("/agent/stream/runs/:id/queue/:itemId", (req, res) => {
  const t = requireTenant(req);
  const ok = t.runStore.queueUpdate(req.params.id, req.params.itemId, String(req.body.text ?? ""));
  if (!ok) return res.status(404).json({ error: "Queue item not found or not editable" });
  res.json({ ok: true });
});

// Delete (cancel) a queued item
v1Router.delete("/agent/stream/runs/:id/queue/:itemId", (req, res) => {
  const t = requireTenant(req);
  const ok = t.runStore.queueDelete(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "Queue item not found" });
  res.json({ ok: true });
});

// Steer a queued item immediately
v1Router.post("/agent/stream/runs/:id/queue/:itemId/steer", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  if (run.status === "completed" || run.status === "error" || run.status === "cancelled") {
    return res.status(409).json({ error: "Run is finished — the item stays queued for delivery as a follow-up." });
  }
  const ok = t.runStore.queueSteer(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "Queue item not found" });
  res.json({ ok: true });
});

// Mark a queued item delivered — the client is sending it as a follow-up run
v1Router.post("/agent/stream/runs/:id/queue/:itemId/delivered", (req, res) => {
  const t = requireTenant(req);
  const ok = t.runStore.queueMarkDelivered(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "Queue item not found" });
  res.json({ ok: true });
});

// Polling fallback / catch-up without holding a stream open.
v1Router.get("/agent/stream/runs/:id/events.json", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  const after = req.query.after ? Number(req.query.after) : 0;
  res.json({ status: run.status, events: t.runStore.eventsAfter(req.params.id, after) });
});

// Steer a live run: the instruction reaches the agent at the next safe model
// boundary. Both runtimes are tried — ownership is not always client-knowable.
v1Router.post("/agent/stream/runs/:id/steer", (req, res) => {
  const t = requireTenant(req);
  const text = String(req.body.text ?? "");
  const ok = t.runStore.steer(req.params.id, text);
  if (!ok) return res.status(409).json({ error: "Run is not active — queue the instruction instead." });
  res.json({ ok: true });
});

// Stop a run. Both runtimes are tried because the client does not always know
// which one owns the id, and cancelling is idempotent either way.
v1Router.post("/agent/stream/runs/:id/cancel", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  if (isTerminal(run.status)) {
    return res.json({ ok: true, status: run.status, alreadyFinished: true });
  }

  const stopped = t.agentRuntime.cancel(req.params.id) || t.multiAgentRuntime.cancel(req.params.id);
  res.json({ ok: stopped, status: stopped ? "cancelled" : run.status });
});

// One-click Undo for a finished run: restores the pre-run snapshot. Modified
// files go back to their pre-run content; files the run created are deleted
// (they are git-dirty and absent from the snapshot). Committed/ignored files
// are never touched, and git history is never rewritten.
v1Router.post("/agent/stream/runs/:id/undo", async (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  if (!run.checkpointId) {
    return res.status(409).json({ error: "This run has no pre-run snapshot to undo to." });
  }
  if (run.status === "running" || run.status === "awaiting_approval") {
    return res.status(409).json({ error: "Stop the run before undoing it." });
  }
  try {
    const { restored, removed } = await t.checkpointEngine.restore(run.projectRoot, run.checkpointId, {
      removeCreated: true,
    });
    t.runStore.emit(req.params.id, "checkpoint.restored", {
      id: run.checkpointId,
      restored: restored.length,
      removed: removed?.length ?? 0,
    });
    res.json({ ok: true, restored, removed });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/agent/stream/approvals/:callId", (req, res) => {
  const t = requireTenant(req);
  const scope = req.body.scope === "mission" ? "mission" : "once";
  // The pending call may live in either runtime (clients cannot always know
  // which one owns the run). Resolve across both — approving is idempotent.
  const ok =
    t.agentRuntime.resolveApproval(req.params.callId, req.body.approved === true, scope) ||
    t.multiAgentRuntime.resolveApproval(req.params.callId, req.body.approved === true, scope);
  if (!ok) return res.status(404).json({ error: "No pending approval with that callId" });
  res.json({ ok: true });
});

v1Router.post("/agent/orchestrate", (req, res) => {
  const t = requireTenant(req);
  // Monthly mission quota (0/unset = unlimited). Checked against the
  // persisted missions table so restarts don't reset the budget.
  const missionQuota = Number(process.env.ORVYN_QUOTA_MISSIONS_MONTH) || 0;
  if (missionQuota > 0) {
    const d = new Date();
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const used = t.localStore.countMissionsSince(monthStart);
    if (used >= missionQuota) {
      return res.status(429).json({
        error: `Monthly mission quota exceeded (${used}/${missionQuota}). Resets at the start of next month (UTC).`,
      });
    }
  }
  _regTools(t, req.body.projectRoot);
  t.usage.agentRuns++;
  // Multi-agent runtime still owns task decomposition. Until each worker has
  // its own run-scoped provider parameter, honor an explicit selection by
  // routing this request through the single-agent ORION tool loop instead of
  // silently ignoring the user's chosen model.
  if (typeof req.body.requestedModelId === "string" && req.body.requestedModelId !== "auto") {
    const runId = t.agentRuntime.start(
      req.body.projectRoot,
      req.body.goal,
      req.body.rules,
      "agent",
      req.body.attachments,
      [],
      req.body.requestedModelId
    );
    return res.status(201).json({ runId, queue: t.multiAgentRuntime.queueStats(), execution: "orion" });
  }
  const runId = t.multiAgentRuntime.start(
    req.body.projectRoot,
    req.body.goal,
    req.body.rules,
    req.body.attachments
  );
  res.status(201).json({ runId, queue: t.multiAgentRuntime.queueStats() });
});

v1Router.post("/agent/orchestrate/approvals/:callId", (req, res) => {
  const t = requireTenant(req);
  const scope = req.body.scope === "mission" ? "mission" : "once";
  // Same cross-runtime resolution as the stream endpoint.
  const ok =
    t.multiAgentRuntime.resolveApproval(req.params.callId, req.body.approved === true, scope) ||
    t.agentRuntime.resolveApproval(req.params.callId, req.body.approved === true, scope);
  if (!ok) return res.status(404).json({ error: "No pending approval with that callId" });
  res.json({ ok: true });
});

// --- Run feedback (thumbs up/down on a finished run) ---
// Appended to a per-tenant log in the local store: enough to review later,
// and the natural place to mine training signal from when that day comes.
v1Router.post("/agent/stream/runs/:id/feedback", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  const kind = req.body.kind === "down" ? "down" : req.body.kind === "up" ? "up" : null;
  if (!kind) return res.status(400).json({ error: 'kind must be "up" or "down"' });

  const key = "feedback";
  let log: unknown[] = [];
  try {
    log = JSON.parse(t.localStore.getSetting(key) ?? "[]");
    if (!Array.isArray(log)) log = [];
  } catch {
    log = [];
  }
  log.push({ runId: req.params.id, kind, at: new Date().toISOString() });
  t.localStore.setSetting(key, JSON.stringify(log.slice(-500)));
  res.json({ ok: true });
});

// --- ORION Memory + durable artifact library ---
v1Router.get("/memory", (req, res) => {
  const t = requireTenant(req);
  const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? "").trim() || null;
  res.json({ memories: t.localStore.listMemories(root) });
});

v1Router.post("/memory", (req, res) => {
  const t = requireTenant(req);
  const content = String(req.body.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "content is required" });
  const scope = req.body.scope === "global" ? "global" : "project";
  const projectRoot = scope === "project" ? String(req.body.projectRoot ?? t.currentProjectRoot ?? "").trim() : null;
  if (scope === "project" && !projectRoot) return res.status(400).json({ error: "projectRoot is required for project memory" });
  const id = String(req.body.id ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  t.localStore.saveMemory({
    id, scope, projectRoot, kind: String(req.body.kind ?? "knowledge"),
    title: String(req.body.title ?? content.slice(0, 80)), content,
    source: req.body.source ? String(req.body.source) : "user", pinned: req.body.pinned === true,
  });
  res.status(201).json({ id });
});

v1Router.patch("/memory/:id", (req, res) => {
  const t = requireTenant(req);
  const current = t.localStore.getMemory(req.params.id);
  if (!current) return res.status(404).json({ error: "memory not found" });
  const scope = req.body.scope === "global" ? "global" : (req.body.scope === "project" ? "project" : current.scope);
  const projectRoot = scope === "project" ? String(req.body.projectRoot ?? current.projectRoot ?? t.currentProjectRoot ?? "").trim() : null;
  if (scope === "project" && !projectRoot) return res.status(400).json({ error: "projectRoot is required for project memory" });
  t.localStore.saveMemory({
    id: current.id, scope, projectRoot,
    kind: String(req.body.kind ?? current.kind),
    title: String(req.body.title ?? current.title),
    content: String(req.body.content ?? current.content),
    source: String(req.body.source ?? current.source ?? "user"),
    pinned: typeof req.body.pinned === "boolean" ? req.body.pinned : current.pinned,
  });
  res.json({ memory: t.localStore.getMemory(current.id) });
});

v1Router.delete("/memory/:id", (req, res) => {
  requireTenant(req).localStore.deleteMemory(req.params.id);
  res.status(204).end();
});

v1Router.get("/artifacts", (req, res) => {
  const t = requireTenant(req);
  const root = String(req.query.projectRoot ?? "").trim() || null;
  res.json({ artifacts: t.localStore.listArtifacts(root) });
});

// --- Checkpoints (snapshot/restore/compare of dirty files) ---
function requireProjectRoot(req: { query: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const root = String((req.body as any)?.projectRoot ?? req.query.projectRoot ?? "").trim();
  if (!root) throw new Error("projectRoot is required");
  return root;
}

v1Router.get("/checkpoints", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = requireProjectRoot(req);
    res.json({ checkpoints: await t.checkpointEngine.list(root) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/checkpoints", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = requireProjectRoot(req);
    const meta = await t.checkpointEngine.create(root, { note: req.body.note });
    res.status(201).json({ checkpoint: meta });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/checkpoints/:id/restore", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = requireProjectRoot(req);
    res.json(await t.checkpointEngine.restore(root, req.params.id));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.get("/checkpoints/:id/compare", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = requireProjectRoot(req);
    res.json(await t.checkpointEngine.compare(root, req.params.id));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.delete("/checkpoints/:id", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = requireProjectRoot(req);
    await t.checkpointEngine.delete(root, req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Missions (Task Engine state for Mission Control) ---
v1Router.get("/missions", (req, res) => {
  const t = requireTenant(req);
  res.json({ missions: t.taskEngine.listMissions().map((m) => t.taskEngine.serialize(m)) });
});

v1Router.get("/missions/:id", (req, res) => {
  const t = requireTenant(req);
  const m = t.taskEngine.getMission(req.params.id);
  if (!m) return res.status(404).json({ error: "Unknown mission" });
  res.json({ mission: t.taskEngine.serialize(m) });
});

// --- Servers (SSH connections from the project's .orvyn/ssh.json) ---
// Lists aliases only — never key material. The renderer uses this for the
// Servers workspace and Home's Connected Systems; live status is checked
// on demand through the approval-gated tool execution route.
v1Router.get("/servers", async (req, res) => {
  const t = requireTenant(req);
  const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? "").trim();
  if (!root) return res.json({ servers: [] });
  try {
    const hosts = await loadSshHosts(root);
    res.json({
      servers: hosts.map((h) => ({ alias: h.alias, host: h.host, user: h.user, port: h.port ?? 22 })),
    });
  } catch {
    // No ssh.json or malformed — an empty list, not an error.
    res.json({ servers: [] });
  }
});

// --- Runtime capabilities (truthful Home connection state) ---
v1Router.get("/runtime/capabilities", async (req, res) => {
  const t = requireTenant(req);
  const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? "").trim();
  let sshHostCount = 0;
  if (root) {
    try { sshHostCount = (await loadSshHosts(root)).length; } catch { sshHostCount = 0; }
  }
  let dockerAvailable = false;
  try { dockerAvailable = await (await import("../sandbox/DockerSandbox")).DockerSandbox.available(); } catch {}
  res.json({
    engineReady: true,
    dockerAvailable,
    sshHostCount,
    // These integrations do not yet expose authoritative connection probes.
    githubConnected: false,
    postgresConnected: false,
    cloudSignedIn: false,
  });
});

// --- MCP servers (status for the Agents view) ---
v1Router.get("/mcp/servers", async (req, res) => {
  try {
    const t = requireTenant(req);
    const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? "").trim();
    if (!root) return res.json({ servers: [] });
    await t.mcpHub.configure(root);
    res.json({ servers: await t.mcpHub.statuses() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Agent roster (live status; pending agents are explicitly marked) ---
import { defaultRoster } from "../agent/Agent";

v1Router.get("/agents", (req, res) => {
  const t = requireTenant(req);
  const routing = t.modelGateway.describe();
  res.json({
    agents: defaultRoster().map((a) => ({
      ...a,
      modelId: routing.find((r) => r.role === a.role)?.modelId ?? null,
    })),
  });
});

v1Router.get("/agent/modes", (_req, res) => {
  res.json({
    modes: Object.values(MODES).map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      toolsEnabled: m.toolsEnabled,
    })),
  });
});

// --- Usage metering (server-side records; the basis for billing later) ---
v1Router.get("/usage", (req, res) => {
  const t = requireTenant(req);
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200;
  res.json({
    totals: t.modelService.usage.totals(),
    quota: t.modelService.usage.quota(),
    queue: t.multiAgentRuntime.queueStats(),
    events: t.modelService.usage.recent(limit),
  });
});

// --- Autonomy profile (spec §47: SAFE / BALANCED / AUTONOMOUS) ---
import { PROFILES, PermissionProfile } from "../gateway/PermissionProfiles";

v1Router.get("/profile", (req, res) => {
  const t = requireTenant(req);
  res.json({
    profile: t.toolGateway.profile,
    profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, ...p })),
  });
});

v1Router.post("/profile", (req, res) => {
  const t = requireTenant(req);
  const profile = String(req.body.profile ?? "").toUpperCase() as PermissionProfile;
  if (!PROFILES[profile]) {
    return res.status(400).json({ error: `Unknown profile "${req.body.profile}". Valid: ${Object.keys(PROFILES).join(", ")}` });
  }
  t.toolGateway.profile = profile;
  t.localStore.setSetting("profile", profile);
  res.json({ ok: true, profile });
});
