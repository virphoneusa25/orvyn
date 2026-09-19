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
  readonly config = CONFIG;
  /** Deep copies, because the runtime mutates its messages array in place. */
  readonly requests: AIRequest[] = [];

  constructor(private turns: AIChunk[][], private onStream?: () => void) {}

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    this.requests.push(JSON.parse(JSON.stringify({ messages: request.messages })));
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

  async generate(): Promise<AIResponse> {
    return { content: "", finishReason: "stop" };
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

function harness(turns: AIChunk[][], opts: { onStream?: () => void } = {}) {
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

  const gateway = new ToolGateway(registry, new PermissionEngine());
  const store = new RunStore();
  const provider = new FakeProvider(turns, opts.onStream);
  const modelService = { router: { resolve: () => provider } } as any;
  const runtime = new StreamingAgentRuntime(modelService, gateway, store);

  return { runtime, store, provider, registry, gateway, executionOrder, stats: () => ({ maxConcurrent }) };
}

function toolCallChunk(id: string, name: string): AIChunk {
  return { delta: "", toolCall: { id, name, arguments: { path: `${name}.ts` } }, done: false };
}

async function waitForStatus(store: RunStore, runId: string, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = store.get(runId)?.status;
    if (status && status !== "running" && status !== "awaiting_approval") return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.get(runId)?.status ?? "unknown";
}

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

  const runId = h.runtime.start("/tmp/project", "read three things");
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

  const runId = h.runtime.start("/tmp/project", "read three things");
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

  const runId = h.runtime.start("/tmp/project", "write two files");
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
  const runId = h.runtime.start("/tmp/project", "try a denied tool", undefined, "plan");
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

  runIdRef = h.runtime.start("/tmp/project", "long task");
  const status = await waitForStatus(h.store, runIdRef);

  assert.equal(status, "cancelled");
  const types = h.store.get(runIdRef)!.events.map((e) => e.type);
  assert.ok(types.includes("run.cancelled"), "a cancelled run must emit run.cancelled");
  assert.ok(!types.includes("run.error"), "cancelling is not an error and must not be reported as one");
});

test("cancel is idempotent and ignores unknown runs", () => {
  const h = harness([[{ delta: "hi", done: true }]]);
  assert.equal(h.runtime.cancel("no-such-run"), false);

  const runId = h.runtime.start("/tmp/project", "task");
  assert.equal(h.runtime.cancel(runId), true);
  assert.equal(h.runtime.cancel(runId), false, "a second cancel should be a no-op");
});

test("records streamed token usage on the run", async () => {
  const h = harness([
    [{ delta: "hello", done: false }, { delta: "", usage: { promptTokens: 120, completionTokens: 35 }, done: true }],
  ]);

  const runId = h.runtime.start("/tmp/project", "say hello");
  assert.equal(await waitForStatus(h.store, runId), "completed");

  const run = h.store.get(runId)!;
  assert.equal(run.usage.promptTokens, 120);
  assert.equal(run.usage.completionTokens, 35);
  assert.equal(run.usage.turns, 1);
  assert.ok(run.events.some((e) => e.type === "usage.updated"));
});

test("stops with a clear error when the run's model-request budget is spent", async () => {
  const previous = process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
  process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = "1";
  try {
    // Turn 1 returns a tool call; turn 2 would finish. With a budget of 1
    // model call the run must stop before the second request.
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [{ delta: "done", done: true }],
    ]);

    const runId = h.runtime.start("/tmp/project", "budget test");
    assert.equal(await waitForStatus(h.store, runId), "error");

    const run = h.store.get(runId)!;
    const budgetError = run.events.find((e) => e.type === "run.error");
    assert.ok(budgetError, "a budget exhaustion must surface as run.error");
    assert.match(String(budgetError.data.message), /Run budget exceeded — model requests: 1\/1/);
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_MODEL_REQUESTS;
    else process.env.ORVYN_RUN_MAX_MODEL_REQUESTS = previous;
  }
});

test("stops with a clear error when the run's tool-call budget is spent", async () => {
  const previous = process.env.ORVYN_RUN_MAX_TOOL_CALLS;
  process.env.ORVYN_RUN_MAX_TOOL_CALLS = "1";
  try {
    // Turn 1 runs one tool; turn 2 requests another — over the cap of 1.
    const h = harness([
      [toolCallChunk("call_a", "read_file"), { delta: "", done: true }],
      [toolCallChunk("call_b", "read_file"), { delta: "", done: true }],
      [{ delta: "done", done: true }],
    ]);

    const runId = h.runtime.start("/tmp/project", "tool budget test");
    assert.equal(await waitForStatus(h.store, runId), "error");

    const run = h.store.get(runId)!;
    const budgetError = run.events.find((e) => e.type === "run.error");
    assert.ok(budgetError, "a budget exhaustion must surface as run.error");
    assert.match(String(budgetError.data.message), /Run budget exceeded — tool calls/);
    // The turn that tripped the cap must not leave unanswered tool calls.
    const requests = h.provider.requests;
    const last = requests[requests.length - 1];
    const assistantToolTurns = last.messages.filter((m) => m.role === "assistant" && m.toolCalls);
    const toolReplies = last.messages.filter((m) => m.role === "tool");
    if (assistantToolTurns.length > 0) {
      assert.equal(toolReplies.length, assistantToolTurns[0].toolCalls!.length, "unanswered tool_calls would 400 the next request");
    }
  } finally {
    if (previous === undefined) delete process.env.ORVYN_RUN_MAX_TOOL_CALLS;
    else process.env.ORVYN_RUN_MAX_TOOL_CALLS = previous;
  }
});
