// apps/backend/src/agent/StreamingAgentRuntime.test.ts
//
// Covers the two properties that are invisible until they break in production:
//
// 1. Every tool call the model requests gets exactly one reply, in order. An
//    unanswered `tool_calls` entry is not a degraded answer — it is a hard 400
//    on the next request, which surfaces as the agent dying mid-task.
// 2. Cancelling a run actually ends it, rather than reporting an error or
//    letting the loop continue in the background.
//
// The gateway and registry are real; only the model provider is faked, because
// the behaviour under test lives in how the runtime drives them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AIChunk, AIRequest, AIResponse, ModelConfig } from "@orvyn/ai-core";
import { ToolRegistry } from "../ai/ToolTypes";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { RunStore } from "./events";
import { StreamingAgentRuntime } from "./StreamingAgentRuntime";

const CONFIG: ModelConfig = {
  id: "fake-model",
  name: "Fake",
  provider: "openai-compatible",
  endpoint: "http://localhost:0",
  contextWindow: 128_000,
  maxOutputTokens: 4_000,
  defaultTemperature: 0,
  defaultTopP: 1,
  streaming: true,
  capabilities: {
    chat: true, code: true, agent: true, tools: true,
    vision: false, embeddings: false, completion: false, image: false,
  },
};

/** A provider that replays a scripted sequence of turns and records requests. */
class FakeProvider {
  readonly config: ModelConfig;
  /** Deep copies, because the runtime mutates its messages array in place. */
  readonly requests: AIRequest[] = [];

  constructor(private turns: AIChunk[][], private onStream?: () => void, config?: Partial<ModelConfig>) {
    this.config = {
      ...CONFIG,
      ...config,
      capabilities: { ...CONFIG.capabilities, ...config?.capabilities },
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    this.requests.push(JSON.parse(JSON.stringify({ messages: request.messages, reasoningEffort: request.reasoningEffort })));
    this.onStream?.();

    const turn = this.turns.shift() ?? [{ delta: "Done.", done: true }];
    for (const chunk of turn) {
      // Honour cancellation the way a real fetch would.
      if (request.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1));
      yield chunk;
    }
  }

  /** Non-streaming calls come from the independent verifier here; this double approves. */
  async generate(): Promise<AIResponse> {
    return { content: "VERDICT: PASS\n- test double", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "online" as const };
  }
  supportsTools() {
    return true;
  }
  supportsVision() {
    return false;
  }
}

function harness(
  turns: AIChunk[][],
  opts: { onStream?: () => void; provider?: FakeProvider; registryModels?: FakeProvider[] } = {}
) {
  const registry = new ToolRegistry();
  const executionOrder: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const makeTool = (name: string, ms = 5) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed" as const,
    async execute() {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      executionOrder.push(name);
      await new Promise((r) => setTimeout(r, ms));
      concurrent--;
      return { ok: true, output: `output of ${name}` };
    },
  });

  // read_file and search_code are READ (parallel-safe); write_file is WRITE.
  registry.register(makeTool("read_file"));
  registry.register(makeTool("search_code"));
  registry.register(makeTool("write_file"));
  registry.register(makeTool("desktop_start"));
  registry.register(makeTool("desktop_click"));

  const gateway = new ToolGateway(registry, new PermissionEngine());
  const store = new RunStore();
  const provider = opts.provider ?? new FakeProvider(turns, opts.onStream);
  const models = opts.registryModels ?? [provider];
  const modelService = {
    router: { resolve: () => provider },
    registry: {
      get: (id: string) => models.find((p) => p.config.id === id),
      list: () => models,
    },
  } as any;
  const runtime = new StreamingAgentRuntime(modelService, gateway, store);

  return { runtime, store, provider, registry, gateway, executionOrder, stats: () => ({ maxConcurrent }) };
}

function toolCallChunk(id: string, name: string): AIChunk {
  const args = name === "write_file" ? { path: `${name}.ts`, content: "body" } : { path: `${name}.ts` };
  return { delta: "", toolCall: { id, name, arguments: args }, done: false };
}

async function waitForStatus(store: RunStore, runId: string, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = store.get(runId)?.status;
    if (status && status !== "running" && status !== "awaiting_approval" && status !== "verifying") return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.get(runId)?.status ?? "unknown";
}

test("boot recovery resumes the same durable run and tells the model to inspect existing work", async () => {
  const h = harness([[{ delta: "Recovered and verified.", done: true }]]);
  const root = mkdtempSync(join(tmpdir(), "orvyn-recover-runtime-"));
  h.store.create("run-recover", root);
  h.store.emit("run-recover", "message.delta", { content: "work completed before restart" });

  const id = (await h.runtime.start(root, "Continue the deployment", undefined, "agent", undefined, [], undefined, undefined, {
    recoverRunId: "run-recover",
  }));
  assert.equal(id, "run-recover");
  assert.equal(await waitForStatus(h.store, id), "completed");
  assert.ok(h.store.get(id)?.events.some((event) => event.data?.content === "work completed before restart"));
  const prompt = h.provider.requests[0]?.messages.map((message) => String(message.content ?? "")).join("\n") ?? "";
  assert.match(prompt, /control plane restarted/i);
  assert.match(prompt, /inspect the current files and git diff/i);
});

test("answers every parallel tool call exactly once, in the order requested", async () => {
  const h = harness([
    [
      toolCallChunk("call_a", "read_file"),
      toolCallChunk("call_b", "search_code"),
      toolCallChunk("call_c", "read_file"),
      { delta: "", done: true },
    ],
    [{ delta: "All three read.", done: true }],
  ]);

  const runId = (await h.runtime.start("/tmp/project", "read three things"));
  assert.equal(await waitForStatus(h.store, runId), "completed");

  // The second request carries the history the first turn produced.
  const followUp = h.provider.requests[1];
  assert.ok(followUp, "the runtime should have made a second model call");

  const assistantTurns = followUp.messages.filter((m) => m.role === "assistant" && m.toolCalls);
  assert.equal(assistantTurns.length, 1);
  assert.equal(assistantTurns[0].toolCalls!.length, 3, "all three calls must be recorded, not just the first");

  const toolReplies = followUp.messages.filter((m) => m.role === "tool");
  assert.equal(toolReplies.length, 3, "every requested call needs exactly one reply");
  assert.deepEqual(
    toolReplies.map((m) => m.toolCallId),
    ["call_a", "call_b", "call_c"],
    "replies must follow the order the model requested"
  );
  for (const reply of toolReplies) {
    assert.match(reply.content, /output of/, "each reply should carry its tool's real output");
  }
});

test("runs read-only tools concurrently", async () => {
  const h = harness([
    [
      toolCallChunk("call_a", "read_file"),
      toolCallChunk("call_b", "search_code"),
      toolCallChunk("call_c", "read_file"),
      { delta: "", done: true },
    ],
    [{ delta: "done", done: true }],
  ]);

  const runId = (await h.runtime.start("/tmp/project", "read three things"));
  await waitForStatus(h.store, runId);

  assert.ok(
    h.stats().maxConcurrent > 1,
    `read-only tools should overlap, but peak concurrency was ${h.stats().maxConcurrent}`
  );
});

test("serialises writes even when requested in the same turn", async () => {
  const h = harness([
    [
      toolCallChunk("call_w1", "write_file"),
      toolCallChunk("call_w2", "write_file"),
      { delta: "", done: true },
    ],
    [{ delta: "done", done: true }],
  ]);
  // BALANCED pre-approves edits, so this exercises execution rather than the
  // approval gate. Setting the permission directly would not work: start()
  // re-applies the mode profile and would overwrite it.
  h.gateway.profile = "BALANCED";

  const runId = (await h.runtime.start("/tmp/project", "write two files"));
  assert.equal(await waitForStatus(h.store, runId), "completed");

  assert.equal(h.stats().maxConcurrent, 1, "two writes must never run at the same time");
});

test("replies to a denied tool instead of leaving the call unanswered", async () => {
  const h = harness([
    [toolCallChunk("call_a", "read_file"), toolCallChunk("call_b", "write_file"), { delta: "", done: true }],
    [{ delta: "ok", done: true }],
  ]);

  // Plan mode denies writes outright — a real configuration, and the branch
  // where a call must still be answered despite never running.
  const runId = (await h.runtime.start("/tmp/project", "try a denied tool", undefined, "plan"));
  assert.equal(await waitForStatus(h.store, runId), "completed");

  const followUp = h.provider.requests[1];
  assert.ok(followUp, "the runtime should have made a second model call");
  const replies = followUp.messages.filter((m) => m.role === "tool");
  assert.equal(replies.length, 2, "a denied call still needs a reply or the next request is malformed");
  assert.deepEqual(replies.map((m) => m.toolCallId), ["call_a", "call_b"]);
  assert.match(replies[1].content, /denied/i);
});

test("cancel ends the run as cancelled, not as an error", async () => {
  let runtimeRef: StreamingAgentRuntime | undefined;
  let runIdRef = "";

  // Cancel as soon as the model starts producing, i.e. mid-generation.
  const h = harness(
    [
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [{ delta: "done", done: true }],
    ],
    { onStream: () => runtimeRef?.cancel(runIdRef) }
  );
  runtimeRef = h.runtime;

  runIdRef = (await h.runtime.start("/tmp/project", "long task"));
  const status = await waitForStatus(h.store, runIdRef);

  assert.equal(status, "cancelled");
  const types = h.store.get(runIdRef)!.events.map((e) => e.type);
  assert.ok(types.includes("run.cancelled"), "a cancelled run must emit run.cancelled");
  assert.ok(!types.includes("run.error"), "cancelling is not an error and must not be reported as one");
});

test("cancel marks the run cancelled without waiting for a hung model call", async () => {
  const hung = new FakeProvider([[{ delta: "still going", done: true }]]);
  hung.stream = async function* (request: AIRequest) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      request.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (request.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    yield { delta: "late", done: true };
  };
  const h = harness([], { provider: hung });
  const runId = (await h.runtime.start("/tmp/project", "do not finish"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runtime.cancel(runId), true);
  assert.equal(h.store.get(runId)?.status, "cancelled");
  assert.ok(h.store.get(runId)?.events.some((event) => event.type === "run.cancelled"));
  assert.equal(h.runtime.cancel(runId), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.store.get(runId)?.status, "cancelled");
  assert.equal(h.store.get(runId)?.events.filter((event) => event.type === "run.cancelled").length, 1);
});

test("cancel is idempotent and ignores unknown runs",  async () => {
  const h = harness([[{ delta: "hi", done: true }]]);
  assert.equal(h.runtime.cancel("no-such-run"), false);

  const runId = (await h.runtime.start("/tmp/project", "task"));
  assert.equal(h.runtime.cancel(runId), true);
  assert.equal(h.runtime.cancel(runId), false, "a second cancel should be a no-op");
});

test("records streamed token usage on the run", async () => {
  const h = harness([
    [{ delta: "hello", done: false }, { delta: "", usage: { promptTokens: 120, completionTokens: 35 }, done: true }],
  ]);

  const runId = (await h.runtime.start("/tmp/project", "say hello"));
  assert.equal(await waitForStatus(h.store, runId), "completed");

  const run = h.store.get(runId)!;
  assert.equal(run.usage.promptTokens, 120);
  assert.equal(run.usage.completionTokens, 35);
  assert.equal(run.usage.turns, 1);
  assert.ok(run.events.some((e) => e.type === "usage.updated"));
});

test("a spent model-request budget ends with a written summary as Partial, not an error", async () => {
    // §4: a budget-limited run is PARTIAL — the outcome has "execution budget" reasons.
  const previous = process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
  process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = "1";
  try {
    // Turn 1 runs a tool and spends the budget of 1. Turn 2 is the wrap-up.
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [{ delta: "Checked the header. Remaining: nothing verified in the browser.", done: true }],
    ]);

    const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "budget test"));
    assert.equal(await waitForStatus(h.store, runId), "partial");

    const run = h.store.get(runId)!;
    assert.ok(!run.events.some((e) => e.type === "run.error"), "reaching the budget is not a failure");
    const reached = run.events.find((e) => e.type === "run.budget_reached");
    assert.ok(reached, "the budget is recorded");
    // The env-var detail rides in `detail` for admins, not the customer message.
    assert.match(String(reached.data.detail), /model requests: 1\/1/);
    const outcome = [...run.events].reverse().find((e) => e.type === "run.outcome");
    assert.equal(outcome?.data.outcome, "partial");
    // The wrap-up turn was told to stop using tools.
    const last = h.provider.requests[h.provider.requests.length - 1];
    assert.ok(last.messages.some((m) => m.role === "user" && /reached its execution budget/.test(String(m.content))));
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
    else process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = previous;
  }
});

test("a model that ignores the budget wrap-up is stopped with a clear error", async () => {
  const previous = process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
  process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = "1";
  try {
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [toolCallChunk("call_b", "read_file"), { delta: "", done: true }],
      [toolCallChunk("call_c", "read_file"), { delta: "", done: true }],
      [{ delta: "done", done: true }],
    ]);
    const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "budget test"));
    assert.equal(await waitForStatus(h.store, runId), "error");
    const err = h.store.get(runId)!.events.find((e) => e.type === "run.error");
    assert.match(String(err?.data.message), /reached its execution limit/);
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
    else process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = previous;
  }
});

test("a spent tool-call budget answers further calls without running them, then settles", async () => {
    // §4: a budget-limited run is PARTIAL.
  const previous = process.env.ORVYN_RUN_MAX_TOOL_CALLS;
  process.env.ORVYN_RUN_MAX_TOOL_CALLS = "1";
  try {
    // Turn 1 runs one tool; turn 2 requests another — over the cap of 1.
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [toolCallChunk("call_b", "read_file"), { delta: "", done: true }],
      [{ delta: "Summary: read one file; nothing else verified.", done: true }],
    ]);

    const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "tool budget test"));
    assert.equal(await waitForStatus(h.store, runId), "partial");

    const run = h.store.get(runId)!;
    const reached = run.events.find((e) => e.type === "run.budget_reached");
    assert.match(String(reached?.data.detail), /tool calls: 1\/1/);
    // Every tool call got exactly one reply (unanswered tool_calls would 400).
    const requests = h.provider.requests;
    const last = requests[requests.length - 1];
    const asked = last.messages.filter((m) => m.role === "assistant" && m.toolCalls).reduce((n, m) => n + m.toolCalls!.length, 0);
    const replies = last.messages.filter((m) => m.role === "tool");
    assert.equal(replies.length, asked, "unanswered tool_calls would 400 the next request");
    assert.match(String(replies[replies.length - 1].content), /Not run: this run has reached its execution budget/);
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_TOOL_CALLS;
    else process.env.ORVYN_RUN_MAX_TOOL_CALLS = previous;
  }
});

test("terminal events carry their call id and bounded real output", async () => {
  const h = harness([[{ delta: "", toolCall: { id: "cmd", name: "terminal", arguments: { command: "echo hello" } }, done: false }, { delta: "", done: true }]]);
  h.registry.register({
    name: "terminal", description: "test terminal", parameters: { type: "object", properties: {} }, defaultPermission: "allowed",
    async execute(_args: Record<string, unknown>, context?: { onOutput?: (chunk: string) => void }) { context?.onOutput?.("live "); return { ok: true, output: "x".repeat(17000) }; },
  });
  const id = (await h.runtime.start("/tmp/project", "run a command"));
  h.gateway.setPermission("terminal", "allowed");
  assert.equal(await waitForStatus(h.store, id), "completed");
  const events = h.store.get(id)!.events.filter(e => e.type.startsWith("terminal."));
  assert.deepEqual(events.map(e => e.type), ["terminal.started", "terminal.output", "terminal.completed"]);
  assert.ok(events.every(e => e.data.callId === "cmd"));
  assert.equal(events[1].data.data, "live ");
  assert.equal(events[1].data.live, true);
});

test("failed writes never emit a successful file change", async () => {
  const h = harness([[toolCallChunk("write", "edit_file"), { delta: "", done: true }]]);
  h.registry.register({
    name: "edit_file", description: "test edit", parameters: { type: "object", properties: {} }, defaultPermission: "allowed",
    async execute() { return { ok: false, error: "Read-only file" }; },
  });
  // BALANCED pre-approves edits on the run-scoped gateway. A post-start
  // setPermission on the shared gateway cannot reach it — runs snapshot
  // their own permission baseline, which is the isolation this suite wants.
  h.gateway.profile = "BALANCED";
  const id = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "edit a file"));
  await waitForStatus(h.store, id);
  const events = h.store.get(id)!.events;
  assert.ok(events.some(e => e.type === "tool.failed"));
  assert.ok(!events.some(e => e.type === "file.edit"));
});

// ---- Composer controls: model/reasoning/access metadata + restore ----------

test("run metadata records requested/actual model, reasoning, and access mode; reasoning reaches the provider", async () => {
  const h = harness([[{ delta: "Done.", done: true }]]);
  const runId = (await h.runtime.start("C:/proj", "hello", undefined, "agent", undefined, [], undefined, undefined, {
    reasoningEffort: "deep",
    accessMode: "auto_workspace",
  }));
  await waitForStatus(h.store, runId);
  const started = h.store.get(runId)!.events.find((e) => e.type === "run.started")!;
  assert.equal(started.data.requestedModelId, "auto");
  assert.equal(started.data.actualModelId, "fake-model");
  assert.equal(started.data.reasoningEffortRequested, "deep");
  assert.equal(started.data.reasoningEffortApplied, "not supported by this model", "truthful when the model declares no support");
  assert.equal(started.data.permissionMode, "Auto Workspace");
  assert.equal(h.provider.requests[0].reasoningEffort, "deep", "provider call carries the effort");
});

test("access mode is run-scoped: the gateway is restored after the run settles", async () => {
  const h = harness([[{ delta: "Done.", done: true }]]);
  h.gateway.profile = "SAFE";
  const runId = (await h.runtime.start("C:/proj", "hello", undefined, "agent", undefined, [], undefined, undefined, {
    accessMode: "full_access",
  }));
  await waitForStatus(h.store, runId);
  // give the async kickoff's finally a beat
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.gateway.profile, "SAFE", "previous autonomy profile restored");
  assert.equal(h.registry.getPermission("terminal"), "ask", "mode baseline re-applied — no upgrade leakage");
});

// ---- Context-usage instrumentation ------------------------------------------

test("usage.updated carries the context breakdown, raw window, and cache rate", async () => {
  const h = harness([
    [toolCallChunk("call_x", "read_file"), { delta: "", done: false }],
    [{ delta: "", usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 80 } as any, done: true }],
    [{ delta: "done", done: true }],
  ]);
  const runId = (await h.runtime.start("C:/proj", "inspect"));
  await waitForStatus(h.store, runId);
  const usage = h.store.get(runId)!.events.filter((e) => e.type === "usage.updated").pop();
  assert.ok(usage, "usage event emitted");
  assert.equal(usage!.data.contextWindow, 128_000, "raw model context window reported");
  const breakdown = usage!.data.contextBreakdown as Record<string, number>;
  assert.ok(breakdown.systemPrompt > 0, "system prompt measured");
  assert.ok(breakdown.toolDefinitions > 0, "tool schemas measured");
  assert.ok(breakdown.messages > 0, "conversation measured");
  assert.equal(breakdown.projectContext, 0, "no retrieval on this harness");
  assert.equal(breakdown.memory, 0);
  assert.ok(Math.abs(Number(usage!.data.cacheHitRate) - 0.8) < 1e-9, "cache hit rate = cached/prompt");
});

// ---- Desktop session events -------------------------------------------------

test("desktop tools emit the desktop.* lifecycle the Workbench derives its tab and cursor from", async () => {
  const h = harness([
    [toolCallChunk("call_d1", "desktop_start"), toolCallChunk("call_d2", "desktop_click"), { delta: "", done: false }],
    [{ delta: "", done: true }],
  ]);
  const runId = (await h.runtime.start("C:/proj", "desktop work"));
  // Desktop tools are approval-gated in agent mode (the real production
  // path) — resolve each approval as the desktop UI's Allow Once does.
  for (let i = 0; i < 40; i++) {
    const evs = h.store.get(runId)?.events ?? [];
    const pending = evs.find((e) => e.type === "approval.required" && !h.store.get(runId)!.events.some((x) => x.type === "approval.resolved" && x.data.callId === e.data.callId));
    if (pending) await h.runtime.resolveApproval(String(pending.data.callId), true);
    if ((h.store.get(runId)?.status ?? "") === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await waitForStatus(h.store, runId);
  const types = h.store.get(runId)!.events.map((e) => e.type);
  assert.ok(types.includes("desktop.started"), "desktop.started");
  // "live" only when the start really succeeded; a failed start says why.
  const started = h.store.get(runId)!.events.find((e) => (e.type === "tool.completed" || e.type === "tool.failed") && e.data?.callId === "call_d1");
  if (started?.type === "tool.completed") assert.ok(types.includes("desktop.ready"), "desktop.ready");
  else assert.ok(types.includes("desktop.failed") && !types.includes("desktop.ready"), "a failed desktop_start is desktop.failed, never desktop.ready");
  const action = h.store.get(runId)!.events.find((e) => e.type === "desktop.action");
  assert.ok(action, "desktop.action for clicks");
  assert.equal((action!.data as any).kind, "click");
});

test("action tasks with no tool call get one nudge", async () => {
  const h = harness([
    [{ delta: "I would edit the file like this.", done: true }],
    [{ delta: "Described the limit after the nudge.", done: true }],
  ]);
  const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "Fix the login bug"));
  assert.equal(await waitForStatus(h.store, runId), "completed");
  assert.equal(h.provider.requests.length, 2);
  const nudge = h.provider.requests[1].messages.find(
    (m) => m.role === "user" && /without calling a tool/.test(String(m.content))
  );
  assert.ok(nudge, "the follow-up turn must demand a real tool call");
});

test("the run prompt is built from live permissions", async () => {
  const h = harness([[{ delta: "hello", done: true }]]);
  const runId = (await h.runtime.start("/tmp/project", "say hello", undefined, "agent", undefined, [], undefined, undefined, {
    composerMode: "server",
  }));
  await waitForStatus(h.store, runId);
  const system = String(h.provider.requests[0].messages[0].content);
  assert.match(system, /Read files: available/);
  assert.match(system, /Edit and create files: available/);
  // Desktop is a core surface exposed on every capable run, not intent-gated.
  assert.match(system, /Desktop and computer-use in this session: available/);
  assert.match(system, /Terminal, tests, builds, dev servers, and SSH: not available/);
  assert.match(system, /not a read-only/);
  assert.doesNotMatch(system, /let the user/i);
});

test("plan mode tells the model the terminal is unavailable", async () => {
  const h = harness([[{ delta: "plan", done: true }]]);
  const runId = (await h.runtime.start("/tmp/project", "say hello", undefined, "plan"));
  await waitForStatus(h.store, runId);
  const system = String(h.provider.requests[0].messages[0].content);
  assert.match(system, /Terminal, tests, builds, dev servers, and SSH: not available/);
  assert.match(system, /This run is read-only/);
});

test("a pinned model that cannot call tools fails instead of chatting", async () => {
  const chatOnly = new FakeProvider([[{ delta: "I can only chat.", done: true }]], undefined, { id: "chat-only" });
  chatOnly.supportsTools = () => false;
  const h = harness([], { provider: chatOnly, registryModels: [chatOnly] });
  const runId = (await h.runtime.start("/tmp/project", "Fix the login bug", undefined, "agent", undefined, [], "chat-only"));
  assert.equal(await waitForStatus(h.store, runId), "error");
  assert.equal(chatOnly.requests.length, 0, "a chat-only pinned model must not be asked to finish the task");
  const err = h.store.get(runId)!.events.find((e) => e.type === "run.error");
  assert.match(String(err?.data.message), /cannot call tools/);
});

test("auto switches off a chat-only model onto one that can call tools", async () => {
  const chatOnly = new FakeProvider([[{ delta: "nope", done: true }]], undefined, { id: "chat-only" });
  chatOnly.supportsTools = () => false;
  const toolful = new FakeProvider([[{ delta: "Done.", done: true }]], undefined, { id: "tool-model" });
  const h = harness([], { provider: chatOnly, registryModels: [chatOnly, toolful] });
  const runId = (await h.runtime.start("/tmp/project", "say hello"));
  assert.equal(await waitForStatus(h.store, runId), "completed");
  assert.equal(chatOnly.requests.length, 0);
  assert.equal(toolful.requests.length, 1);
  const started = h.store.get(runId)!.events.find((e) => e.type === "run.started");
  assert.equal(started?.data.actualModelId, "tool-model");
  assert.ok(h.store.get(runId)!.events.some((e) => e.type === "model.fallback"));
});

test("a service diagnosis with no workspace or server is blocked before git or MCP", async () => {
  const h = harness([[{ delta: "I will run git status.", done: true }]]);
  const runId = (await h.runtime.start("/tmp/orvyn-not-a-workspace", "Diagnose a failing service"));
  assert.equal(await waitForStatus(h.store, runId), "blocked");
  assert.equal(h.provider.requests.length, 0);
  const events = h.store.get(runId)!.events;
  assert.equal(events.some((e) => e.type === "run.completed"), false);
  assert.equal(events.some((e) => e.type === "run.execution"), false);
  assert.equal(events.some((e) => e.type === "tool.started"), false);
  const text = events.map((e) => JSON.stringify(e.data)).join("\n");
  assert.match(text, /project, server, or environment/i);
  const diag = events.find((e) => e.type === "run.diagnostics");
  const names = (diag?.data.toolNames as string[] | undefined) ?? [];
  assert.equal(names.some((n) => /git_|mcp/i.test(n)), false);
});

test("a server task with no configured server is blocked and does not call the model", async () => {
  const h = harness([[{ delta: "I will ssh somewhere.", done: true }]]);
  const runId = (await h.runtime.start("/tmp/orvyn-no-such-project", "Log into my configured test server and tell me its hostname and uptime."));
  assert.equal(await waitForStatus(h.store, runId), "blocked");
  assert.equal(h.provider.requests.length, 0);
  const events = h.store.get(runId)!.events;
  assert.ok(events.some((e) => e.type === "resource.required"));
  assert.equal(events.some((e) => e.type === "run.completed"), false);
  assert.equal(events.some((e) => e.type === "tool.started"), false);
  const diag = events.find((e) => e.type === "run.diagnostics");
  assert.equal((diag?.data.taskIntent as { category?: string })?.category, "server");
  assert.equal(JSON.stringify(diag?.data).includes("password"), false);
});

test("a model stream that never yields is aborted by the idle watchdog, not left hanging", async () => {
  const previousIdle = process.env.ORVYN_MODEL_STREAM_IDLE_MS;
  process.env.ORVYN_MODEL_STREAM_IDLE_MS = "150";
  try {
    // A provider whose stream accepts the request and then never yields a
    // chunk — the exact production freeze (failover retry on a dead
    // connection): no content, no error, forever.
    class HungProvider extends FakeProvider {
      async *stream(request: AIRequest): AsyncIterable<AIChunk> {
        this.requests.push(JSON.parse(JSON.stringify({ messages: request.messages })));
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        }); // resolves only when the idle watchdog aborts the call
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }
    }
    const hung = new HungProvider([], undefined);
    const healthy = new FakeProvider([[{ delta: "Recovered.", done: true }]]);
    hung.config.id = "hung:test/model";
    healthy.config.id = "ok:test/model";
    const h = harness([], { provider: hung, registryModels: [hung, healthy] });

    const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "say something"));
    const status = await waitForStatus(h.store, runId, 10_000);
    assert.notEqual(status, "running", "the run must not sit in running forever");
    assert.ok(["completed", "partial", "error", "failed", "cancelled"].includes(status), `settled state, got ${status}`);
  } finally {
    if (previousIdle === undefined) delete process.env.ORVYN_MODEL_STREAM_IDLE_MS;
    else process.env.ORVYN_MODEL_STREAM_IDLE_MS = previousIdle;
  }
});

// The event NAME must match the outcome: a UI that listens for "run.completed"
// must never see one for a mission that did not fully pass its settlement
// criteria. mission.settled is the canonical record; run.* events are
// status-specific mirrors of it.
test("a partially-settled run emits run.partial and never run.completed", async () => {
  const previous = process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
  process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = "1";
  try {
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [{ delta: "Read the file. Nothing was verified.", done: true }],
    ]);
    const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "partial event test"));
    assert.equal(await waitForStatus(h.store, runId), "partial");

    const events = h.store.get(runId)!.events;
    assert.equal(
      events.some((e) => e.type === "run.completed"),
      false,
      "run.completed on a partial mission is the exact false-completion bug"
    );
    const partial = events.find((e) => e.type === "run.partial");
    assert.ok(partial, "a partial settlement emits run.partial");
    assert.equal(partial.data.outcome, "partial");
    // mission.settled is the authoritative terminal record and must agree.
    const settled = events.find((e) => e.type === "mission.settled");
    assert.equal(settled?.data.status, "partial");
    // No terminal event may contradict the settled status.
    for (const e of events) {
      if (e.type === "mission.settled") assert.equal(e.data.status, "partial");
    }
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
    else process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = previous;
  }
});

test("a fully-settled run emits run.completed and never run.partial", async () => {
  const h = harness([[{ delta: "Done.", done: true }]]);
  const runId = (await h.runtime.start(mkdtempSync(join(tmpdir(), "orvyn-run-")), "completed event test"));
  assert.equal(await waitForStatus(h.store, runId), "completed");

  const events = h.store.get(runId)!.events;
  assert.ok(events.some((e) => e.type === "run.completed"), "a completed mission emits run.completed");
  assert.equal(events.some((e) => e.type === "run.partial"), false);
  const settled = events.find((e) => e.type === "mission.settled");
  assert.equal(settled?.data.status, "completed");
  // run.completed may only appear after the settlement decision.
  const idxSettled = events.findIndex((e) => e.type === "mission.settled");
  const idxCompleted = events.findIndex((e) => e.type === "run.completed");
  assert.ok(idxSettled >= 0 && idxCompleted > idxSettled, "settlement precedes the completed event");
});


test("persisted admission uses its server-generated id and cannot replace an existing run", async () => {
  const h = harness([[{ delta: "Verified.", done: true }]]);
  const root = mkdtempSync(join(tmpdir(), "orvyn-admitted-run-"));
  const id = (await h.runtime.start(root, "Explain this project", undefined, "ask", undefined, [], undefined, undefined, { admittedRunId: "run-admitted" }));
  assert.equal(id, "run-admitted");
  (await assert.rejects( async () => (await h.runtime.start(root, "duplicate", undefined, "ask", undefined, [], undefined, undefined, { admittedRunId: id })), /already exists/));
  await waitForStatus(h.store, id);
});

test("website review executes browser tools and sends the captured frame to a vision model", async () => {
  const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const vision = new FakeProvider([
    [{delta:"",toolCall:{id:"open-site",name:"browser_open",arguments:{url:"https://example.com"}},done:false},{delta:"",done:true}],
    [{delta:"",toolCall:{id:"inspect-site",name:"browser_screenshot",arguments:{}},done:false},{delta:"",done:true}],
    [{delta:"I inspected the rendered website. The header and main content are visible.",done:true}],
  ],undefined,{id:"vision-website-fixture",capabilities:{...CONFIG.capabilities,vision:true}});
  vision.supportsVision = () => true;
  const h = harness([],{provider:vision});
  h.registry.register({name:"browser_open",description:"Open website",parameters:{type:"object",properties:{url:{type:"string"}},required:["url"]},defaultPermission:"allowed",
    async execute(){return {ok:true,output:"Opened the website",meta:{url:"https://example.com",browserSessionId:"browser-fixture"}};}});
  h.registry.register({name:"browser_screenshot",description:"Capture rendered website",parameters:{type:"object",properties:{}},defaultPermission:"allowed",
    async execute(){return {ok:true,output:"Captured screenshot",meta:{screenshot:{b64:screenshot,mediaType:"image/png"},browserSessionId:"browser-fixture"}};}});
  const root=mkdtempSync(join(tmpdir(),"orvyn-website-review-"));
  const runId=await h.runtime.start(root,"Review https://example.com",undefined,"agent",undefined,[],undefined,undefined,{approvedTools:["browser_open","browser_screenshot"]});
  const status=await waitForStatus(h.store,runId,8000);
  const events=h.store.get(runId)!.events;
  assert.equal(status,"completed",JSON.stringify(events.filter(event=>/error|blocked|outcome/.test(event.type))));
  for(const tool of ["browser_open","browser_screenshot"]) assert.ok(events.some(event=>event.type==="tool.completed"&&event.data?.tool===tool),tool);
  assert.ok(vision.requests.some(request=>request.messages.some(message=>message.attachments?.some(asset=>asset.kind==="image"&&asset.b64===screenshot))),"the screenshot must reach the model, not just the UI");
  assert.ok(!events.some(event=>event.type==="file.created"||event.type==="file.edit"||event.type==="terminal.started"),"review must not create a replacement website");
});
