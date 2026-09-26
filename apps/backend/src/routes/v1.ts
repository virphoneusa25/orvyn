import { documentRouter } from "./documents";
import { learnFromUserMessage, type MemoryStoreLike } from "../memory/userMemory";
import { memoryModel } from "../memory/learnModel";
import { mcpRouter } from "./mcp";
import { desktopRouter } from "./desktop";
import { workerRouter, hasOnlineWorker } from "./worker";
import { localWorkerRouter, hasOnlineLocalWorker, queueLocalHostJob, localWorkerHealth, localWorkerServices, requestLocalServiceStop } from "./localWorker";
import { serviceManager, type ServiceRecord } from "../services/ServiceManager";
import { summarizeRuns, threadHistory } from "../agent/runThread";
import { recordRunAnswer, recordRunInstruction } from "../sessions/sessionMessages";
import { sessionState } from "../sessions/sessionState";
import { cloudWorkerSourcePath, isVirtualWorkspace, looksLikeForeignAbsolutePath, resolveWorkspace } from "../documents/workspace";
import { routeExecutionTarget, runtimeLocation, isExecutionTarget } from "../execution/ExecutionTarget";
import { classifyExecutionHints } from "../execution/classifyExecution";
import { portForwardingService } from "../ports/PortForwardingService";
// apps/backend/src/routes/v1.ts
import { Router } from "express";
import { requirePrincipal, requireTenant } from "../middleware/tenant";
import { authService } from "../auth/AuthService";
import { tenantManager } from "../tenancy/TenantManager";
import { Orchestrator } from "../ai/Orchestrator";
import { InlineEditService } from "../edit/InlineEditService";
import { CompleteService } from "../edit/CompleteService";
import { ImageService } from "../images/ImageService";
import { composerRunsAsMissions } from "../agent/missionList";
import { MODES } from "../agent/modes";
import { chatCapabilityPrompt } from "../agent/runCapabilities";
import path from "path";
import { promises as fsp } from "fs";

export const v1Router = Router();
v1Router.use("/documents", documentRouter);
v1Router.use("/desktop", desktopRouter());
v1Router.use("/mcp", mcpRouter(requireTenant));
v1Router.use("/local-worker", localWorkerRouter(requireTenant, (tenantId: string) => {
  const tenant = tenantManager.get(tenantId) ?? (tenantId === "default" ? tenantManager.ensureLocalDefault() : undefined);
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  return tenant.runStore;
}));
// ── Services (dev servers ORION started) ─────────────────────────────────
// "local": on the user's computer, reported by the Local Worker.
// "cloud": on this host (an ORVYN Cloud workspace, or the same-host backend).
function hostServicesFor(t: { id: string; currentProjectRoot?: string | null }): ServiceRecord[] {
  const cloudHost = process.env.ORVYN_CLOUD_MODE === "true" || Boolean(process.env.ORVYN_PROJECTS_DIR);
  return serviceManager.list().filter((s) =>
    s.tenantId === t.id || isVirtualWorkspace(s.projectRoot, t.id) || (!cloudHost && (!s.tenantId || s.projectRoot === t.currentProjectRoot))
  );
}

v1Router.get("/services", (req, res) => {
  const t = requireTenant(req);
  const cloudHost = process.env.ORVYN_CLOUD_MODE === "true" || Boolean(process.env.ORVYN_PROJECTS_DIR);
  res.json({
    services: [
      ...localWorkerServices(t.id).map((s) => ({ ...s, location: "local" as const })),
      ...hostServicesFor(t).map((s) => ({ ...s, location: cloudHost ? "cloud" as const : "local" as const, cwd: undefined })),
    ],
  });
});

v1Router.post("/services/:id/stop", (req, res) => {
  const t = requireTenant(req);
  const id = String(req.params.id);
  if (hostServicesFor(t).some((s) => s.serviceId === id)) {
    serviceManager.stop(id, "stopped by the user");
    return res.json({ ok: true });
  }
  if (requestLocalServiceStop(t.id, id)) return res.json({ ok: true, pending: true });
  res.status(404).json({ error: "Unknown service" });
});

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
    const forcedRemote = req.body?.executionLocation === "OVH_WORKER"
      || req.body?.executionTarget === "ovh_worker"
      || req.body?.executionTarget === "local_host"
      || req.body?.executionTarget === "local_sandbox";
    // Phase 2: a run started from the desktop with its own machine path (e.g.
    // C:\Users\me\project) names the user's LOCAL project. It must reach the
    // route untouched so Auto can send it to the Local Worker — rewriting it to
    // the Cloud virtual workspace silently wrote "local" files on the server.
    const runStart = req.method === "POST" && req.path === "/agent/stream/runs";
    const clientMachineRoot = runStart
      && typeof req.body?.projectRoot === "string"
      && looksLikeForeignAbsolutePath(req.body.projectRoot.trim());
    if (!forcedRemote && !clientMachineRoot && req.body?.projectRoot !== undefined && req.body.projectRoot !== null) req.body.projectRoot = await resolveWorkspace(requireTenant(req), req.body.projectRoot);
    if (req.query.projectRoot !== undefined) req.query.projectRoot = await resolveWorkspace(requireTenant(req), req.query.projectRoot);
    if (req.method === "POST" && ["/agent/stream/runs", "/agent/orchestrate"].includes(req.path)) {
      const tenant = requireTenant(req);
      if (tenant.runStore.list().some(run => ["running", "queued", "awaiting_approval"].includes(run.status))) return res.status(409).json({error:"A task is already active. Stop it or wait before starting another."});
      if (!forcedRemote && !clientMachineRoot) req.body.projectRoot = await resolveWorkspace(tenant, req.body.projectRoot);
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

v1Router.get("/models/roles", (req, res) => {
  const t = requireTenant(req);
  const roles = t.modelService.roles();
  res.json({
    roles,
    production: roles.filter((r) => r.task !== "image").every((r) => r.production),
  });
});

v1Router.get("/session", (req, res) => {
  const t = requireTenant(req);
  const principal = req.principal;
  res.json({
    tenantId: t.id,
    principal: principal ?? null,
    organizations: principal ? authService.listOrganizations(principal.userId) : [],
  });
});

v1Router.get("/organizations", (req, res) => {
  const principal = requirePrincipal(req);
  res.json({ organizations: authService.listOrganizations(principal.userId) });
});

v1Router.post("/organizations", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const organization = authService.createOrganization(principal, String(req.body.name ?? "Organization"));
    res.status(201).json({ organization });
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

v1Router.post("/organizations/:id/members", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    authService.addOrganizationMember(principal, req.params.id, String(req.body.userId ?? ""), req.body.role === "admin" ? "admin" : "member");
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(err.status ?? 404).json({ error: "Not found" });
  }
});

v1Router.get("/projects", (req, res) => {
  const principal = requirePrincipal(req);
  res.json({ projects: authService.listProjects(principal.tenantId) });
});

v1Router.post("/projects", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const project = authService.createProject(principal, String(req.body.name ?? "Untitled project"), req.body.projectRoot);
    res.status(201).json({ project });
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

v1Router.get("/projects/:id", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    res.json({ project: authService.getProject(req.params.id, principal.tenantId) });
  } catch (err: any) {
    res.status(err.status ?? 404).json({ error: "Not found" });
  }
});

v1Router.get("/chats", (req, res) => {
  const principal = requirePrincipal(req);
  res.json({ chats: authService.listChats(principal.tenantId) });
});

v1Router.post("/chats", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const chat = authService.createChat(principal, String(req.body.title ?? "New chat"));
    res.status(201).json({ chat });
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

v1Router.get("/chats/:id", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    res.json({ chat: authService.getChat(req.params.id, principal.tenantId) });
  } catch (err: any) {
    res.status(err.status ?? 404).json({ error: "Not found" });
  }
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
  if (!req.body.projectRoot) return res.status(400).json({ error: "projectRoot required" });
  t.usage.indexBuilds++;
  t.indexService.bindProject(req.body.projectRoot, req.body.projectId);
  if (req.body.background === true) {
    void t.indexService.build(req.body.projectRoot, { rebuild: Boolean(req.body.rebuild), projectId: req.body.projectId });
    return res.status(202).json({ stats: t.indexService.getStats() });
  }
  const stats = await t.indexService.build(req.body.projectRoot, { rebuild: Boolean(req.body.rebuild), projectId: req.body.projectId });
  if (stats.status === "error") return res.status(500).json({ stats });
  res.json({ stats });
});

v1Router.post("/index/watch", (req, res) => {
  const t = requireTenant(req);
  if (!req.body.projectRoot) return res.status(400).json({ error: "projectRoot required" });
  t.indexService.watch(req.body.projectRoot);
  res.json({ stats: t.indexService.getStats() });
});

v1Router.post("/index/update", async (req, res) => {
  const t = requireTenant(req);
  if (!req.body.projectRoot) return res.status(400).json({ error: "projectRoot required" });
  t.indexService.bindProject(req.body.projectRoot, req.body.projectId);
  if (req.body.deleted) await t.indexService.removeFile(String(req.body.path ?? ""));
  else if (req.body.from && req.body.to) await t.indexService.renameFile(String(req.body.from), String(req.body.to));
  else if (req.body.path) await t.indexService.updateFile(String(req.body.path));
  else await t.indexService.build(req.body.projectRoot, { projectId: req.body.projectId });
  res.json({ stats: t.indexService.getStats() });
});

v1Router.post("/index/cancel", (req, res) => {
  requireTenant(req).indexService.cancelBuild();
  res.json({ stats: requireTenant(req).indexService.getStats() });
});

v1Router.delete("/index", async (req, res) => {
  await requireTenant(req).indexService.deleteIndex();
  res.json({ stats: requireTenant(req).indexService.getStats() });
});

v1Router.get("/index/status", (req, res) => {
  res.json({ stats: requireTenant(req).indexService.getStats() });
});

v1Router.post("/index/snapshot", async (req, res) => {
  try {
    const t = requireTenant(req);
    if (!req.body.projectRoot) return res.status(400).json({ error: "projectRoot required" });
    const { buildProjectSnapshot } = await import("../indexing/projectSnapshot");
    const snapshot = await buildProjectSnapshot(t.id, req.body.projectRoot, {
      projectId: req.body.projectId,
      source: req.body.source,
    });
    res.json({ snapshot });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/search/semantic", async (req, res) => {
  try {
    const t = requireTenant(req);
    if (req.body.projectRoot) t.indexService.bindProject(req.body.projectRoot, req.body.projectId);
    const hits = await t.indexService.search(req.body.query, req.body.topK ?? 5);
    res.json({ hits });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.post("/search/hybrid", async (req, res) => {
  try {
    const t = requireTenant(req);
    if (req.body.projectRoot) t.indexService.bindProject(req.body.projectRoot, req.body.projectId);
    const hits = await t.indexService.searchHybrid(req.body.query, req.body.topK ?? 10);
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
    const t = requireTenant(req);
    const result = await new ImageService(t.modelService, t.artifactService).generate({
      ...req.body,
      projectRoot: req.body.projectRoot ?? t.currentProjectRoot ?? undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Chat (non-streaming; use WS /ws/chat for streaming) ---
v1Router.post("/chat/completions", async (req, res) => {
  try {
    const tc = requireTenant(req);
    const message = String(req.body.message ?? "");
    const composerMode = String(req.body.composerMode ?? req.body.mode ?? "auto");
    const intent = inferTaskIntent(message, composerMode);
    const chip = composerMode.toLowerCase();
    if (!intent.informational && chip !== "research" && chip !== "ask" && chip !== "plan") {
      const projectRoot = String(req.body.projectRoot ?? tc.currentProjectRoot ?? "");
      _regTools(tc, projectRoot);
      const runId = tc.agentRuntime.start(projectRoot, message, req.body.rules, "agent", req.body.attachments, req.body.history ?? [], req.body.requestedModelId, undefined, {
        composerMode: chip,
      });
      return res.status(201).json({ runId, routed: "agent" });
    }
    const response = await new Orchestrator(tc.modelService, tc.indexService, tc.artifactService, tc.localStore as unknown as MemoryStoreLike).chat({
      task: req.body.task ?? "chat",
      history: req.body.history ?? [],
      userMessage: req.body.message,
      context: req.body.context,
      reasoningEffort: req.body.reasoningEffort,
      capabilityPrompt: chatCapabilityPrompt(tc.toolGateway.list().map((t) => t.name)),
    });
    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



// --- Streaming agent runs (typed event protocol) ---
import { registerProjectToolsFor as _regTools } from "../ai/registerProjectTools";
import { isTerminal } from "../agent/events";
import { isAccessMode } from "../gateway/PermissionProfiles";
import { loadSshHosts } from "../ai/tools/sshTools";
import { inferTaskIntent } from "../agent/taskIntent";
import { notePublicOrigin } from "../agent/sitePreview";

// Start a run. Returns a runId immediately; the client then opens the SSE
// stream below. Kept separate from the stream so a dropped connection never
// aborts the run itself.
v1Router.post("/agent/stream/runs", (req, res) => {
  const t = requireTenant(req);

  const requestedTarget = isExecutionTarget(req.body.executionTarget)
    ? req.body.executionTarget
    : req.body.executionLocation === "OVH_WORKER"
      ? "ovh_worker"
      : "auto";
  const resolvedRoot = String(req.body.projectRoot ?? "").trim();
  const virtualWorkspace = Boolean(resolvedRoot) && isVirtualWorkspace(resolvedRoot, t.id);
  const hasLocalProject = Boolean(resolvedRoot) && !virtualWorkspace;
  const hints = classifyExecutionHints(String(req.body.instruction ?? req.body.goal ?? ""), String(req.body.composerMode ?? req.body.mode ?? "auto"));
  const cloudHost = process.env.ORVYN_CLOUD_MODE === "true" || Boolean(process.env.ORVYN_PROJECTS_DIR);
  const routed = routeExecutionTarget({
    requested: requestedTarget,
    mode: String(req.body.composerMode ?? req.body.mode ?? "auto"),
    hasLocalProject,
    isRisky: req.body.isRisky === true || hints.isRisky,
    isBackground: req.body.isBackground === true || hints.isBackground,
    requiresRemote: req.body.executionLocation === "OVH_WORKER" || String(req.body.composerMode ?? "") === "server" || hints.requiresRemote,
    isArtifact: hints.isArtifact,
    isLocalCoding: hints.isLocalCoding,
    isSite: hints.isSite,
    cloudControlPlane: cloudHost,
  });

  const localWorkerOnline = hasOnlineLocalWorker(t.id);
  const inProcessLocal = !cloudHost;
  // Virtual workspace + generated-file work lives on the Cloud control plane.
  // Auto must not demand the desktop Local Worker or an OVH sandbox for a logo.
  const controlPlaneVirtual =
    requestedTarget === "auto" &&
    (virtualWorkspace || (cloudHost && hints.isArtifact && !hasLocalProject));

  if (routed.actual === "ovh_worker" && !controlPlaneVirtual) {
    if (!hasOnlineWorker()) {
      if (routed.requested === "auto") {
        routed.actual = "local_host";
        routed.fallbackReason = "Auto chose Cloud but no ORVYN Cloud worker is online — running Local instead";
      } else {
        return res.status(409).json({
          error: "ORVYN Cloud has no worker available right now — the Cloud run was not started. It is never moved to your computer silently.",
          executionTargetRequested: routed.requested,
          executionTargetActual: routed.actual,
        });
      }
    }
  } else if (!controlPlaneVirtual && (routed.actual === "local_host" || routed.actual === "local_sandbox")) {
    if (cloudHost && !localWorkerOnline && !inProcessLocal) {
      return res.status(409).json({
        error: routed.actual === "local_sandbox"
          ? "Local Sandbox requires the desktop Local Worker (and Docker). It is offline — the project was not sent to ORVYN Cloud."
          : "Local execution requires the desktop Local Worker. It is offline — the project was not sent to ORVYN Cloud.",
        executionTargetRequested: routed.requested,
        executionTargetActual: routed.actual,
      });
    }
  }

  const location = controlPlaneVirtual
    ? "LOCAL"
    : runtimeLocation(routed.actual, { inProcessLocal: routed.actual === "local_host" && inProcessLocal && !localWorkerOnline });
  const clientProjectRoot = String(req.body.remoteProjectRoot ?? req.body.projectRoot ?? "");
  const remoteProjectRoot = location === "OVH_WORKER" ? cloudWorkerSourcePath(clientProjectRoot) : clientProjectRoot;
  const executionLabel = controlPlaneVirtual && cloudHost
    ? "Cloud"
    : routed.actual === "local_host" ? "Local" : routed.actual === "local_sandbox" ? "Local Sandbox" : "ORVYN Cloud";

  notePublicOrigin(
    String(req.headers["x-forwarded-proto"] || req.protocol || "https"),
    String(req.headers["x-forwarded-host"] || req.get("host") || "")
  );
  _regTools(t, location === "LOCAL" ? req.body.projectRoot : (req.body.projectRoot || t.currentProjectRoot || remoteProjectRoot));
  t.usage.agentRuns++;
  const previousById = typeof req.body.previousRunId === "string" ? t.runStore.get(req.body.previousRunId) : undefined;
  // Every run belongs to a durable WorkSession: the chat's (sessionId), the
  // previous run's, or a new one for a new conversation.
  let session = typeof req.body.sessionId === "string" ? t.sessions.get(req.body.sessionId) : undefined;
  if (!session && previousById) session = t.sessions.sessionOfRun(previousById.id);
  if (!session) {
    session = t.sessions.create({
      title: String(req.body.instruction ?? "").split("\n")[0]!.slice(0, 80) || "New conversation",
      userId: req.principal?.userId ?? "",
      projectRoot: String(req.body.projectRoot ?? remoteProjectRoot ?? "") || null,
    });
  }
  // A follow-up continues the conversation: the session's runs are its history.
  const history: {role: "user" | "assistant";content:string}[] = threadHistory(t.runStore, session.runIds);
  const runId = t.agentRuntime.start(
    req.body.projectRoot || remoteProjectRoot || t.currentProjectRoot || "",
    req.body.instruction,
    req.body.rules,
    req.body.mode ?? "agent",
    req.body.attachments,
    history,
    typeof req.body.requestedModelId === "string" ? req.body.requestedModelId : undefined,
    {
      location,
      remoteProjectRoot,
      tenantId: t.id,
      organizationId: req.principal?.organizationId ?? "",
      userId: req.principal?.userId ?? "",
      projectId: typeof req.body.projectId === "string" ? req.body.projectId : null,
      targetRequested: routed.requested,
      targetActual: routed.actual,
      executionLabel,
      // Local runs execute on the user's computer: tell the model its shell.
      hostPlatform: location === "LOCAL_HOST" || location === "LOCAL_SANDBOX"
        ? (localWorkerHealth(t.id).environment?.os ?? undefined)
        : location === "OVH_WORKER" ? "linux" : process.platform,
      fallbackReason: routed.fallbackReason ?? (location === "LOCAL" && routed.actual === "local_host" && !controlPlaneVirtual ? "in-process local backend (same host)" : undefined),
    },
    {
      reasoningEffort: ["auto", "fast", "standard", "deep", "max"].includes(req.body.reasoningEffort)
        ? req.body.reasoningEffort
        : undefined,
      accessMode: isAccessMode(req.body.permissionMode) ? req.body.permissionMode : undefined,
      composerMode: typeof req.body.composerMode === "string" ? req.body.composerMode : undefined,
    }
  );
  if ((location === "LOCAL_HOST" || location === "LOCAL_SANDBOX") && localWorkerOnline) {
    queueLocalHostJob(runId, remoteProjectRoot, t.id, routed.actual === "local_sandbox" ? "local_sandbox" : "local_host");
  }
  const attached = t.sessions.attachRun(session.sessionId, runId, String(req.body.projectRoot || remoteProjectRoot || "") || null) ?? session;
  if (t.runStore.get(runId)) t.runStore.emit(runId, "run.session", { sessionId: attached.sessionId, workspaceId: attached.workspaceId, projectId: attached.projectId });
  // The conversation is stored as it happens: the instruction now, ORION's answer when the run ends.
  const userMessage = recordRunInstruction(t.sessions, attached.sessionId, runId, String(req.body.instruction ?? ""), {
    messageId: typeof req.body.messageId === "string" ? req.body.messageId : undefined,
    mode: String(req.body.mode ?? "agent"),
  });
  recordRunAnswer(t.sessions, t.runStore, attached.sessionId, runId);
  // What the user says about themselves or their work is remembered for next time.
  void learnFromUserMessage(t.localStore as unknown as MemoryStoreLike, memoryModel(t.modelService), String(req.body.instruction ?? ""));
  res.status(201).json({
    runId,
    messageId: userMessage?.messageId,
    messageSequence: userMessage?.sequence,
    sessionId: attached.sessionId,
    workspaceId: attached.workspaceId,
    projectId: attached.projectId,
    executionLocation: location,
    executionTargetRequested: routed.requested,
    executionTargetActual: routed.actual,
    executionLabel,
  });
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
        execution: buildRunReplay(r),
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

  // A write after the stream ended (events can follow run.completed, e.g. the
  // session marker or a late verification row) must never crash the engine.
  const unsubscribe = t.runStore.subscribe(req.params.id, (e) => {
    if (res.writableEnded || res.destroyed) { unsubscribe(); return; }
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === "run.completed" || e.type === "run.error" || e.type === "run.cancelled" || e.type === "run.blocked") {
      clearInterval(heartbeat);
      res.end();
      unsubscribe();
    }
  });
  res.on("error", () => { clearInterval(heartbeat); unsubscribe(); });

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
  if (isTerminal(run.status)) {
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
  if (isTerminal(run.status)) {
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

// ── WorkSessions: the durable record of a conversation and its work ─────────
v1Router.get("/sessions", (req, res) => {
  const t = requireTenant(req);
  res.json({ sessions: t.sessions.list().map((x) => ({ ...x, ...t.sessions.messageSummary(x.sessionId) })) });
});

v1Router.post("/sessions", (req, res) => {
  const t = requireTenant(req);
  const s = t.sessions.create({
    title: String(req.body?.title ?? "New conversation"),
    userId: req.principal?.userId ?? "",
    projectRoot: typeof req.body?.projectRoot === "string" ? req.body.projectRoot : null,
  });
  res.status(201).json({ session: s });
});

v1Router.get("/sessions/:id", (req, res) => {
  const t = requireTenant(req);
  const s = t.sessions.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: "Unknown session" });
  res.json({ session: s, runs: summarizeRuns(t.runStore, s.runIds) });
});

// Everything the session produced: project, runs, changed files, artifacts,
// newest live preview. Reopening a conversation restores from this.
v1Router.get("/sessions/:id/state", (req, res) => {
  const t = requireTenant(req);
  const s = t.sessions.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: "Unknown session" });
  res.json(sessionState(t.sessions, t.runStore, s));
});

// ---- Durable messages of a session ------------------------------------------
v1Router.get("/sessions/:id/messages", (req, res) => {
  const t = requireTenant(req);
  const s = t.sessions.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: "Unknown session" });
  const after = Math.max(0, Number(req.query.after) || 0);
  res.json({ sessionId: s.sessionId, messages: t.sessions.messages(s.sessionId, after) });
});

v1Router.post("/sessions/:id/messages", (req, res) => {
  const t = requireTenant(req);
  const role = String(req.body?.role ?? "");
  if (!["user", "assistant", "system"].includes(role)) return res.status(400).json({ error: "role must be user, assistant or system" });
  if (typeof req.body?.content !== "string") return res.status(400).json({ error: "content is required" });
  const m = t.sessions.appendMessage(String(req.params.id), {
    messageId: typeof req.body.messageId === "string" ? req.body.messageId : undefined,
    role: role as "user" | "assistant" | "system",
    content: req.body.content,
    runId: typeof req.body.runId === "string" ? req.body.runId : null,
    mode: typeof req.body.mode === "string" ? req.body.mode : null,
    status: req.body.status === "streaming" ? "streaming" : "complete",
    createdAt: Number(req.body.createdAt) || undefined,
  });
  if (!m) return res.status(404).json({ error: "Unknown session (or that message belongs to another session)" });
  res.status(201).json({ message: m });
});

v1Router.patch("/sessions/:id/messages/:messageId", (req, res) => {
  const t = requireTenant(req);
  const existing = t.sessions.getMessage(String(req.params.messageId));
  if (!existing || existing.sessionId !== String(req.params.id)) return res.status(404).json({ error: "Unknown message" });
  const m = t.sessions.updateMessage(existing.messageId, {
    content: typeof req.body?.content === "string" ? req.body.content : undefined,
    runId: typeof req.body?.runId === "string" ? req.body.runId : undefined,
    status: req.body?.status === "streaming" ? "streaming" : req.body?.status === "complete" ? "complete" : undefined,
  });
  res.json({ message: m });
});

v1Router.patch("/sessions/:id", (req, res) => {
  const t = requireTenant(req);
  const s = t.sessions.update(String(req.params.id), { title: req.body?.title, status: req.body?.status, pinned: typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined });
  if (!s) return res.status(404).json({ error: "Unknown session" });
  res.json({ session: s });
});

v1Router.delete("/sessions/:id", (req, res) => {
  const t = requireTenant(req);
  res.json({ ok: t.sessions.delete(String(req.params.id)) });
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
  // One agent loop. Mission requests use the same runtime as chat runs.
  const reasoningEffort = ["auto", "fast", "standard", "deep", "max"].includes(req.body.reasoningEffort)
    ? req.body.reasoningEffort
    : undefined;
  const accessMode = isAccessMode(req.body.permissionMode) ? req.body.permissionMode : undefined;
  const runId = t.agentRuntime.start(
    req.body.projectRoot,
    req.body.goal,
    req.body.rules,
    "agent",
    req.body.attachments,
    [],
    typeof req.body.requestedModelId === "string" ? req.body.requestedModelId : undefined,
    undefined,
    { reasoningEffort, accessMode, composerMode: typeof req.body.composerMode === "string" ? req.body.composerMode : undefined }
  );
  // Missions are work sessions too: the run joins the given session or a new one.
  const missionSession = (typeof req.body.sessionId === "string" ? t.sessions.get(req.body.sessionId) : undefined)
    ?? t.sessions.create({ title: String(req.body.goal ?? "Mission").split("\n")[0]!.slice(0, 80), userId: req.principal?.userId ?? "", projectRoot: req.body.projectRoot ?? null });
  const joined = t.sessions.attachRun(missionSession.sessionId, runId, req.body.projectRoot ?? null) ?? missionSession;
  if (t.runStore.get(runId)) t.runStore.emit(runId, "run.session", { sessionId: joined.sessionId, workspaceId: joined.workspaceId, projectId: joined.projectId });
  recordRunInstruction(t.sessions, joined.sessionId, runId, String(req.body.goal ?? ""), { messageId: typeof req.body.messageId === "string" ? req.body.messageId : undefined, mode: "mission" });
  recordRunAnswer(t.sessions, t.runStore, joined.sessionId, runId);
  res.status(201).json({ runId, sessionId: joined.sessionId, queue: t.multiAgentRuntime.queueStats(), execution: "orion" });
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

function publicArtifact(svc: { toPublic: (a: any) => unknown }, record: any) {
  return svc.toPublic(record);
}

v1Router.get("/artifacts", (req, res) => {
  const t = requireTenant(req);
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const rows = q ? t.artifactService.search(q) : t.artifactService.listArtifacts({ kind });
  res.json({ artifacts: rows.map((a) => publicArtifact(t.artifactService, a)) });
});

v1Router.get("/files", async (req, res) => {
  try {
    const t = requireTenant(req);
    const requested = typeof req.query.projectRoot === "string" && req.query.projectRoot
      ? String(req.query.projectRoot)
      : t.currentProjectRoot;
    const root = requested && looksLikeForeignAbsolutePath(requested)
      ? t.artifactService.virtualRoot()
      : requested;
    res.json(await t.artifactService.filesTree(root));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.get("/files/read", async (req, res) => {
  try {
    const t = requireTenant(req);
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (id) {
      const { record, bytes } = await t.artifactService.read(id);
      const textish = (record.mediaType ?? "").startsWith("text/") || /\.(md|txt|json|csv|html|svg)$/i.test(record.name);
      return res.json({
        artifact: publicArtifact(t.artifactService, record),
        content: textish ? bytes.toString("utf-8") : undefined,
        dataUrl: !textish && record.mimeType.startsWith("image/")
          ? `data:${record.mimeType};base64,${bytes.toString("base64")}`
          : undefined,
      });
    }
    const rel = String(req.query.path ?? "").replace(/^\/+/, "").replace(/\\/g, "/");
    if (/(^|\/)generated\//i.test(rel) || /^generated(\/|$)/i.test(rel)) {
      return res.status(404).json({ error: "Artifact unavailable" });
    }
    const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? t.artifactService.virtualRoot());
    const abs = path.resolve(root, rel);
    const base = path.resolve(root);
    const relSafe = path.relative(base, abs);
    if (relSafe.startsWith("..") || path.isAbsolute(relSafe)) {
      return res.status(400).json({ error: "Path is outside the workspace." });
    }
    const bytes = await fsp.readFile(abs);
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    const image = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
    res.json({
      path: rel,
      content: image ? undefined : bytes.toString("utf-8").slice(0, 40_000),
      dataUrl: image ? `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${bytes.toString("base64")}` : undefined,
    });
  } catch (err: any) {
    const raw = String(err?.message ?? "");
    res.status(404).json({ error: /enoent|not found|no such file/i.test(raw) ? "Artifact unavailable" : "Could not open this file." });
  }
});

v1Router.post("/artifacts", async (req, res) => {
  try {
    const t = requireTenant(req);
    const rec = await t.artifactService.create({
      name: String(req.body.name ?? "file.txt"),
      kind: req.body.kind,
      content: req.body.content != null ? String(req.body.content) : undefined,
      bytes: typeof req.body.base64 === "string" ? Buffer.from(req.body.base64, "base64") : undefined,
      mediaType: req.body.mediaType,
      runId: req.body.runId,
      projectRoot: req.body.projectRoot ?? t.currentProjectRoot,
    });
    res.status(201).json({ artifact: publicArtifact(t.artifactService, rec) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.get("/artifacts/:id", async (req, res) => {
  try {
    const { record, bytes } = await requireTenant(req).artifactService.read(req.params.id);
    const textish = (record.mediaType ?? "").startsWith("text/") || /\.(md|txt|json|csv|html)$/i.test(record.name);
    res.json({
      artifact: publicArtifact(requireTenant(req).artifactService, record),
      content: textish ? bytes.toString("utf-8") : undefined,
      dataUrl: record.mimeType.startsWith("image/") ? `data:${record.mimeType};base64,${bytes.toString("base64")}` : undefined,
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

v1Router.get("/artifacts/:id/preview", async (req, res) => {
  try {
    const t = requireTenant(req);
    const { record, bytes, filename } = await t.artifactService.previewArtifact(req.params.id);
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

v1Router.get("/artifacts/:id/download", async (req, res) => {
  try {
    const t = requireTenant(req);
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (token) {
      const resolved = t.artifactService.resolveDownload(token);
      if (resolved !== req.params.id) return res.status(403).json({ error: "Token does not match this artifact." });
    }
    const { record, bytes, filename } = await t.artifactService.getDownload(req.params.id);
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

v1Router.get("/files/search", (req, res) => {
  const t = requireTenant(req);
  const q = String(req.query.q ?? "");
  res.json({ artifacts: t.artifactService.search(q).map((a) => publicArtifact(t.artifactService, a)) });
});

v1Router.delete("/artifacts/:id", async (req, res) => {
  try {
    await requireTenant(req).artifactService.delete(req.params.id);
    res.status(204).end();
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
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
  const missions = t.taskEngine.listMissions().map((m) => t.taskEngine.serialize(m));
  const seen = new Set(missions.map((m) => m.runId));
  const runs = composerRunsAsMissions(t.runStore.list(), seen);
  res.json({ missions: [...missions, ...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) });
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
  const local = localWorkerHealth(t.id);
  res.json({
    engineReady: process.env.ORVYN_CLOUD_MODE === "true" ? local.state !== "offline" : true,
    localEngineState: local.state,
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
  const totals = t.modelService.usage.totals();
  const cost = estimateRunCost({
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
  });
  res.json({
    totals,
    quota: t.modelService.usage.quota(),
    entitlements: entitlements.limits(),
    billing: { provider: billing.name, ...cost },
    queue: t.multiAgentRuntime.queueStats(),
    events: t.modelService.usage.recent(limit),
  });
});

import { ModelRegistry } from "../learning/ModelRegistry";
import { persistSkillCandidates } from "../learning/skillCandidates";
import { listValidatedSkills, seedValidatedSkills } from "../learning/validatedSkills";
import { persistDataset } from "../learning/datasetBuilder";
import { buildRunReplay } from "../learning/runReplay";
import { NullBillingProvider, estimateRunCost } from "../billing/BillingProvider";
import { EntitlementService } from "../billing/EntitlementService";
import { creditLedger } from "../billing/creditLedgerInstance";
import { BillingLimitError } from "../billing/CreditLedger";
import { packById, planById, type PackId, type PlanId } from "../billing/plans";
import { DEFAULT_PRIVACY, bindTenantResource } from "../orgs/organization";
import { getHostDesktopState, setHostDesktopAllowed, takeHostControl, returnHostControl } from "../desktop/hostDesktopSession";

const billing = new NullBillingProvider();
const entitlements = new EntitlementService();

v1Router.get("/learning", (req, res) => {
  const t = requireTenant(req);
  res.json({
    tenantId: t.id,
    trainingOptOut: DEFAULT_PRIVACY.trainingOptOut,
    overview: t.experienceStore.overview(),
  });
});

v1Router.get("/learning/experiences", (req, res) => {
  const t = requireTenant(req);
  const rows = t.experienceStore.list("experience", 80).filter((e) => {
    try {
      bindTenantResource(t.id, e.tenantId);
      return true;
    } catch {
      return false;
    }
  });
  res.json({ experiences: rows });
});

v1Router.get("/learning/skills", (req, res) => {
  const t = requireTenant(req);
  res.json({ skills: t.localStore.listLearningRecords("skill", 80).map((r) => r.payload) });
});

v1Router.get("/skills", (req, res) => {
  const t = requireTenant(req);
  seedValidatedSkills(t.localStore);
  res.json({ skills: listValidatedSkills(t.localStore) });
});

v1Router.get("/agent/skills", (req, res) => {
  const t = requireTenant(req);
  seedValidatedSkills(t.localStore);
  res.json({ skills: listValidatedSkills(t.localStore) });
});

v1Router.get("/learning/datasets", (req, res) => {
  const t = requireTenant(req);
  res.json({ datasets: t.localStore.listLearningRecords("dataset", 40).map((r) => r.payload) });
});

v1Router.get("/learning/evaluations", (req, res) => {
  const t = requireTenant(req);
  res.json({
    evaluations: t.experienceStore.list("experience", 80).map((e) => ({
      runId: e.runId,
      result: e.result,
      evaluation: e.evaluation,
    })),
  });
});

v1Router.get("/learning/failures", (req, res) => {
  const t = requireTenant(req);
  res.json({ clusters: t.experienceStore.overview().failureClusters });
});

v1Router.get("/learning/models", (req, res) => {
  const t = requireTenant(req);
  res.json({ models: new ModelRegistry(t.localStore).list() });
});

v1Router.post("/learning/models", (req, res) => {
  const t = requireTenant(req);
  const version = String(req.body.version ?? "").trim();
  if (!version) return res.status(400).json({ error: "version is required" });
  const row = new ModelRegistry(t.localStore).register({
    version,
    datasetVersion: req.body.datasetVersion ? String(req.body.datasetVersion) : undefined,
    benchmark: req.body.benchmark,
  });
  res.status(201).json(row);
});

v1Router.post("/learning/models/:id/status", (req, res) => {
  const t = requireTenant(req);
  try {
    const row = new ModelRegistry(t.localStore).setStatus(req.params.id, req.body.status);
    if (!row) return res.status(404).json({ error: "Unknown model" });
    res.json(row);
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

v1Router.post("/learning/refresh", (req, res) => {
  const t = requireTenant(req);
  if (DEFAULT_PRIVACY.trainingOptOut) {
    return res.json({ ok: true, skipped: true, reason: "Training opt-out is on" });
  }
  const experiences = t.experienceStore.list("experience", 80);
  const skills = persistSkillCandidates(t.localStore, experiences);
  const dataset = persistDataset(t.localStore, experiences);
  res.json({ ok: true, skills: skills.length, dataset });
});

v1Router.get("/billing", (req, res) => {
  const t = requireTenant(req);
  const totals = t.modelService.usage.totals();
  const wallet = creditLedger.snapshot(t.id);
  res.json({
    provider: billing.name,
    note: wallet.note,
    wallet,
    entitlements: entitlements.limits(),
    used: {
      tokenBudget: totals.promptTokens + totals.completionTokens,
      cloudMinutes: 0,
      storageBytes: 0,
      concurrentMissions: t.multiAgentRuntime.queueStats().running,
      artifactStorageBytes: 0,
    },
    cost: estimateRunCost({
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
    }),
  });
});

v1Router.post("/billing/topup", (req, res) => {
  const t = requireTenant(req);
  const pack = packById(String(req.body?.packId ?? ""));
  if (!pack) return res.status(400).json({ error: "Unknown credit pack." });
  try {
    const order = creditLedger.purchase(t.id, pack.id as PackId);
    res.json({ order, wallet: creditLedger.snapshot(t.id) });
  } catch (err) {
    const message = err instanceof BillingLimitError ? err.message : "Could not add credits.";
    res.status(409).json({ error: message });
  }
});

v1Router.post("/billing/plan", (req, res) => {
  const t = requireTenant(req);
  const plan = planById(String(req.body?.planId ?? ""));
  if (!["starter", "pro", "team", "enterprise"].includes(plan.id) || String(req.body?.planId) !== plan.id) {
    return res.status(400).json({ error: "Unknown plan." });
  }
  creditLedger.setPlan(t.id, plan.id as PlanId);
  res.json({ wallet: creditLedger.snapshot(t.id) });
});

v1Router.post("/billing/auto-recharge", (req, res) => {
  const t = requireTenant(req);
  const pack = packById(String(req.body?.packId ?? "pack_5k"));
  if (!pack) return res.status(400).json({ error: "Unknown credit pack." });
  const threshold = Number(req.body?.threshold ?? 500);
  const maxPerMonth = Number(req.body?.maxPerMonth ?? 3);
  try {
    creditLedger.setAutoRecharge(t.id, { threshold, packId: pack.id as PackId, maxPerMonth });
    res.json({ wallet: creditLedger.snapshot(t.id) });
  } catch (err) {
    const message = err instanceof BillingLimitError ? err.message : "Could not save auto-recharge.";
    res.status(400).json({ error: message });
  }
});

v1Router.get("/privacy", (_req, res) => {
  res.json({ privacy: DEFAULT_PRIVACY });
});

v1Router.get("/host-desktop", (req, res) => {
  res.json(getHostDesktopState(requireTenant(req).id));
});

v1Router.post("/host-desktop/allow", (req, res) => {
  res.json(setHostDesktopAllowed(requireTenant(req).id, req.body.allowed === true));
});

v1Router.post("/host-desktop/take-control", (req, res) => {
  res.json(takeHostControl(requireTenant(req).id));
});

v1Router.post("/host-desktop/return-control", (req, res) => {
  res.json(returnHostControl(requireTenant(req).id));
});

v1Router.get("/agent/stream/runs/:id/replay", (req, res) => {
  const t = requireTenant(req);
  const run = t.runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Unknown run" });
  res.json(buildRunReplay(run));
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

function requestPublicBase(req: { protocol?: string; get?: (h: string) => string | undefined; headers?: Record<string, unknown> }): string {
  const env = process.env.ORVYN_PUBLIC_URL || process.env.ORVYN_STAGING_URL;
  if (env) return env.replace(/\/$/, "");
  const host = req.get?.("host") || String(req.headers?.host ?? "127.0.0.1:4570");
  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

function portEnv(raw: unknown): "local" | "sandbox" | "cloud" {
  const v = String(raw ?? "local").toLowerCase();
  if (v === "sandbox" || v === "local_sandbox") return "sandbox";
  if (v === "cloud" || v === "ovh_worker") return "cloud";
  return "local";
}

v1Router.get("/ports", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    res.json({ ports: portForwardingService.list(principal.tenantId, runId) });
  } catch (err: any) {
    res.status(err.status ?? 401).json({ error: err.message });
  }
});

v1Router.post("/ports/detect", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const ports = Array.isArray(req.body?.ports) ? req.body.ports : [];
    res.json({
      ports: portForwardingService.detect({
        tenantId: principal.tenantId,
        userId: principal.userId,
        runId: req.body?.runId,
        workspace: req.body?.workspace,
        environment: portEnv(req.body?.environment),
        ports: ports.map((p: any) => ({ port: Number(p.port), command: p.command })),
        autoForward: req.body?.autoForward !== false,
        publicBase: requestPublicBase(req),
      }),
    });
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

v1Router.post("/ports/forward", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    const port = Number(req.body?.port);
    if (!port) return res.status(400).json({ error: "port is required" });
    res.json({
      port: portForwardingService.forward({
        tenantId: principal.tenantId,
        userId: principal.userId,
        runId: req.body?.runId,
        workspace: req.body?.workspace,
        environment: portEnv(req.body?.environment),
        port,
        command: req.body?.command,
        publicBase: requestPublicBase(req),
      }),
    });
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

v1Router.post("/ports/:id/stop", (req, res) => {
  try {
    const principal = requirePrincipal(req);
    res.json({ port: portForwardingService.stop(principal.tenantId, req.params.id) });
  } catch (err: any) {
    res.status(err.status ?? 404).json({ error: err.message });
  }
});

v1Router.all("/ports/:id/proxy", (req, res) => {
  try {
    const token = typeof req.query.fwd === "string" ? req.query.fwd : "";
    const rec = portForwardingService.authorizeByToken(req.params.id, token);
    portForwardingService.proxy(rec, req, res);
  } catch (err: any) {
    if (!res.headersSent) res.status(err.status ?? 404).json({ error: "Not found" });
  }
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
