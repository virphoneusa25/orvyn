// apps/backend/src/routes/v1.ts
import { Router } from "express";
import { modelService } from "../services/ModelService";
import { toolRegistry } from "../ai/ToolTypes";
import { Orchestrator } from "../ai/Orchestrator";
import { IndexService } from "../indexing/IndexService";
import { HashingEmbedder } from "../indexing/embeddings";
import { InMemoryVectorStore } from "../indexing/vectorStore";
import { InlineEditService } from "../edit/InlineEditService";

export const v1Router = Router();
export const indexService = new IndexService(new HashingEmbedder(), new InMemoryVectorStore());
const orchestrator = new Orchestrator(modelService, indexService);

// Note: GET /api/v1/health is registered unauthenticated directly on the
// Express app in index.ts (before apiKeyAuth), not here.

// --- Models ---
v1Router.get("/models", (_req, res) => {
  res.json({ models: modelService.list() });
});

v1Router.post("/models", (req, res) => {
  try {
    const provider = modelService.addModel(req.body);
    res.status(201).json({ model: provider.config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.put("/models/:id", (req, res) => {
  try {
    modelService.removeModel(req.params.id);
    const provider = modelService.addModel({ ...req.body, id: req.params.id });
    res.json({ model: provider.config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.delete("/models/:id", (req, res) => {
  modelService.removeModel(req.params.id);
  res.status(204).end();
});

v1Router.get("/models/health", async (_req, res) => {
  res.json({ results: await modelService.healthCheckAll() });
});

// "Test Model" button: round-trips a tiny real prompt through the model
// (not just a health ping) and reports latency + a response snippet, so
// the user can confirm the model is actually reachable and answering.
v1Router.post("/models/:id/test", async (req, res) => {
  const provider = modelService.registry.get(req.params.id);
  if (!provider) return res.status(404).json({ error: `Unknown model "${req.params.id}"` });

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
v1Router.get("/routing", (_req, res) => {
  res.json({ overrides: modelService.router.getOverrides() });
});

v1Router.post("/routing", (req, res) => {
  const { task, modelId } = req.body;
  if (!modelService.registry.get(modelId)) {
    return res.status(400).json({ error: `Unknown model "${modelId}"` });
  }
  modelService.router.setOverride(task, modelId);
  res.json({ overrides: modelService.router.getOverrides() });
});

v1Router.delete("/routing/:task", (req, res) => {
  modelService.router.clearOverride(req.params.task as any);
  res.json({ overrides: modelService.router.getOverrides() });
});

// --- Codebase indexing / RAG ---
v1Router.post("/index/build", async (req, res) => {
  const stats = await indexService.build(req.body.projectRoot);
  if (stats.status === "error") return res.status(500).json({ stats });
  res.json({ stats });
});

v1Router.get("/index/status", (_req, res) => {
  res.json({ stats: indexService.getStats() });
});

v1Router.post("/search/semantic", async (req, res) => {
  try {
    const hits = await indexService.search(req.body.query, req.body.topK ?? 5);
    res.json({ hits });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Composer (multi-file plan/apply) ---
import { ComposerService } from "../composer/ComposerService";
const composerService = new ComposerService(modelService);

v1Router.post("/composer/plan", async (req, res) => {
  try {
    const plan = await composerService.plan(req.body.projectRoot, req.body.instruction, req.body.rules);
    res.json({ plan });
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
});

v1Router.post("/composer/apply", async (req, res) => {
  try {
    const written = await composerService.apply(req.body.projectRoot, req.body.files);
    res.json({ written });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Agent (tool-calling loop with approval pauses) ---
import { AgentService } from "../agent/AgentService";
import { registerProjectTools } from "../ai/registerProjectTools";
const agentService = new AgentService(modelService);

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
    registerProjectTools(req.body.projectRoot);
    const session = await agentService.start(req.body.projectRoot, req.body.instruction, req.body.rules);
    res.status(201).json({ session: serializeSession(session) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

v1Router.get("/agent/runs/:id", (req, res) => {
  const session = agentService.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json({ session: serializeSession(session) });
});

v1Router.post("/agent/runs/:id/approve", async (req, res) => {
  try {
    const session = await agentService.approve(req.params.id, req.body.approved === true);
    res.json({ session: serializeSession(session) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Tools ---
v1Router.get("/tools", (req, res) => {
  if (req.query.projectRoot) registerProjectTools(String(req.query.projectRoot));
  res.json({
    tools: toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      permission: toolRegistry.getPermission(t.name),
    })),
  });
});

v1Router.post("/tools/:name/permission", (req, res) => {
  toolRegistry.setPermission(req.params.name, req.body.permission);
  res.json({ ok: true });
});

v1Router.post("/tools/:name/execute", async (req, res) => {
  const permission = toolRegistry.getPermission(req.params.name);
  if (permission === "ask" && req.body.approved !== true) {
    return res.status(428).json({ error: "Approval required", requiresApproval: true });
  }
  const result = await toolRegistry.execute(req.params.name, req.body.args ?? {});
  res.json(result);
});

// --- Inline edit (Ctrl+K) ---
v1Router.post("/edit/inline", async (req, res) => {
  try {
    const result = await new InlineEditService(modelService).edit(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Chat (non-streaming; use WS /ws/chat for streaming) ---
v1Router.post("/chat/completions", async (req, res) => {
  try {
    const response = await orchestrator.chat({
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

export { orchestrator };
