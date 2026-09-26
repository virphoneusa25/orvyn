// A malformed tool call is a correctable schema error. The same run receives
// the missing fields and retries. Argument errors do not climb the model ladder.
// A permission denial is a different class and still can.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AIChunk, AIRequest, AIResponse, ModelConfig } from "@orvyn/ai-core";
import { ToolRegistry } from "../ai/ToolTypes";
import { makeReadFileTool, makeWriteFileTool } from "../ai/tools/fileTools";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { RunStore } from "./events";
import { StreamingAgentRuntime } from "./StreamingAgentRuntime";

const CODE_ID = "fw:accounts/fireworks/models/kimi-k2p7-code";
const HEAVY_ID = "fw:accounts/fireworks/models/glm-5p3";
const PROMPT = "Create index.html containing Hello World.";

const BASE: ModelConfig = {
  id: CODE_ID,
  name: "Code",
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

class ScriptedModel {
  readonly config: ModelConfig;
  readonly requests: AIRequest[] = [];
  constructor(private turns: AIChunk[][], id: string) {
    this.config = { ...BASE, id, name: id };
  }
  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    this.requests.push(JSON.parse(JSON.stringify({ messages: request.messages })));
    const turn = this.turns.shift() ?? [{ delta: "Done.", done: true }];
    for (const chunk of turn) yield chunk;
  }
  async generate(): Promise<AIResponse> {
    return { content: "VERDICT: PASS\n- ok", finishReason: "stop" };
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

function call(id: string, args: Record<string, unknown>, name = "write_file"): AIChunk {
  return { delta: "", toolCall: { id, name, arguments: args }, done: false };
}

function harness(primaryTurns: AIChunk[][], opts: { heavyTurns?: AIChunk[][]; write?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orvyn-tool-"));
  const registry = new ToolRegistry();
  if (opts.write !== false) {
    registry.register(makeReadFileTool(root));
    registry.register(makeWriteFileTool(root));
  }
  const primary = new ScriptedModel(primaryTurns, CODE_ID);
  const heavy = new ScriptedModel(opts.heavyTurns ?? [[{ delta: "Done.", done: true }]], HEAVY_ID);
  const gateway = new ToolGateway(registry, new PermissionEngine());
  const store = new RunStore();
  const modelService = {
    router: { resolve: () => primary },
    registry: {
      get: (id: string) => (id === HEAVY_ID ? heavy : id === CODE_ID ? primary : undefined),
      list: () => [primary, heavy],
    },
  } as any;
  const runtime = new StreamingAgentRuntime(modelService, gateway, store);
  return { root, runtime, store, primary, heavy, registry, gateway };
}

async function settle(store: RunStore, runId: string, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = store.get(runId)?.status;
    if (status && status !== "running" && status !== "awaiting_approval" && status !== "verifying") return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  return store.get(runId)?.status ?? "unknown";
}

function toolMessages(request: AIRequest | undefined): string[] {
  return (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
}

test("a write that omits content is corrected in the same run without escalation", async () => {
  const h = harness([
    [call("w1", { path: "index.html" }), { delta: "", done: true }],
    [call("w2", { path: "index.html", content: "Hello World" }), { delta: "", done: true }],
    [{ delta: "Created index.html with Hello World.", done: true }],
  ]);
  const runId = h.runtime.start(h.root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(h.store, runId), "completed");

  const failed = h.store.get(runId)!.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.data.errorType, "INVALID_ARGUMENTS");
  assert.deepEqual(failed[0]!.data.missing, ["content"]);
  assert.equal(failed[0]!.data.retryable, true);

  const feedback = toolMessages(h.primary.requests[1]).join("\n");
  const parsed = JSON.parse(feedback);
  assert.equal(parsed.errorType, "INVALID_ARGUMENTS");
  assert.deepEqual(parsed.missing, ["content"]);
  assert.equal(parsed.retryable, true);
  assert.ok(parsed.schema.required.includes("content"));

  const assistants = h.primary.requests[2]!.messages.filter((m) => m.role === "assistant" && m.toolCalls);
  const retry = assistants[assistants.length - 1];
  const args = retry?.toolCalls?.[0]?.arguments as { path?: string; content?: string };
  assert.equal(args.path, "index.html");
  assert.equal(args.content, "Hello World");
  assert.equal(readFileSync(join(h.root, "index.html"), "utf8"), "Hello World");

  const types = h.store.get(runId)!.events.map((e) => e.type);
  assert.equal(types.includes("route.escalated"), false);
  assert.equal(types.includes("model.escalated"), false);
  assert.equal(h.heavy.requests.length, 0);
  assert.equal(h.primary.config.id, CODE_ID);
});

test("a write that omits path names path and then retries with both fields", async () => {
  const h = harness([
    [call("w1", { content: "Hello World" }), { delta: "", done: true }],
    [call("w2", { path: "index.html", content: "Hello World" }), { delta: "", done: true }],
    [{ delta: "Created index.html.", done: true }],
  ]);
  const runId = h.runtime.start(h.root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(h.store, runId), "completed");

  const failed = h.store.get(runId)!.events.find((e) => e.type === "tool.failed")!;
  assert.equal(failed.data.errorType, "INVALID_ARGUMENTS");
  assert.deepEqual(failed.data.missing, ["path"]);
  const parsed = JSON.parse(toolMessages(h.primary.requests[1])[0]!);
  assert.ok(parsed.missing.includes("path"));
  assert.equal(parsed.errorType, "INVALID_ARGUMENTS");
  assert.equal(readFileSync(join(h.root, "index.html"), "utf8"), "Hello World");
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "route.escalated"), false);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "model.escalated"), false);
});

test("three invalid argument calls do not escalate, and the third identical call is blocked", async () => {
  const same = { path: "index.html" };
  const h = harness([
    [
      call("a", same),
      call("b", { path: "about.html" }),
      call("c", {}),
      { delta: "", done: true },
    ],
    [{ delta: "I still need the file contents.", done: true }],
  ]);
  const runId = h.runtime.start(h.root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(h.store, runId), "completed");
  const failed = h.store.get(runId)!.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 3);
  assert.ok(failed.every((e) => e.data.errorType === "INVALID_ARGUMENTS"));
  assert.deepEqual(failed[2]!.data.missing, ["path", "content"]);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "route.escalated"), false);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "model.escalated"), false);
  assert.equal(h.heavy.requests.length, 0);

  const loop = harness([
    [call("a", same), { delta: "", done: true }],
    [call("b", same), { delta: "", done: true }],
    [call("c", same), { delta: "", done: true }],
    [{ delta: "should not be asked again", done: true }],
  ]);
  const stopped = loop.runtime.start(loop.root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(loop.store, stopped), "error");
  const errors = loop.store.get(stopped)!.events.filter((e) => e.type === "tool.failed");
  assert.equal(errors.length, 3);
  assert.equal(errors[0]!.data.retryable, true);
  assert.equal(errors[1]!.data.retryable, true);
  assert.equal(errors[2]!.data.retryable, false);
  assert.equal(errors[2]!.data.blocked, true);
  const runError = loop.store.get(stopped)!.events.find((e) => e.type === "run.error")!;
  assert.match(String(runError.data.message), /will not repeat that call/);
  assert.equal(loop.store.get(stopped)!.events.some((e) => e.type === "route.escalated"), false);
  assert.equal(loop.heavy.requests.length, 0);
  assert.equal(loop.primary.requests.length, 3);
});

test("permission denial is not an argument error and still escalates", async () => {
  const args = { path: "index.html", content: "Hello World" };
  const h = harness([
    [call("a", args), call("b", args), call("c", args), { delta: "", done: true }],
  ]);
  const runId = h.runtime.start(h.root, PROMPT, undefined, "plan");
  assert.equal(await settle(h.store, runId), "completed");
  const failed = h.store.get(runId)!.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 3);
  assert.ok(failed.every((e) => e.data.errorType === "PERMISSION_DENIED"));
  assert.ok(failed.every((e) => e.data.errorType !== "INVALID_ARGUMENTS"));
  const feedback = toolMessages(h.heavy.requests[0] ?? h.primary.requests[1]).join("\n");
  const parsed = JSON.parse(toolMessages(h.primary.requests[1] ? h.primary.requests[1] : h.heavy.requests[0])[0] ?? feedback);
  assert.equal(parsed.errorType, "PERMISSION_DENIED");
  assert.equal(parsed.retryable, false);
  assert.equal(parsed.missing, undefined);
  assert.match(JSON.stringify(parsed), /denied/i);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "route.escalated"), true);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "model.escalated"), true);
  assert.ok(h.heavy.requests.length >= 1);
});

test("a missing workspace file is RESOURCE_MISSING and names the real entries", async () => {
  const h = harness([
    [call("r1", { path: "missing.txt" }, "read_file"), { delta: "", done: true }],
    [{ delta: "The file is not there.", done: true }],
  ]);
  const { writeFileSync } = await import("fs");
  writeFileSync(join(h.root, "notes.txt"), "keep");
  const runId = h.runtime.start(h.root, "Read the file missing.txt", undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(h.store, runId), "completed");
  const failed = h.store.get(runId)!.events.find((e) => e.type === "tool.failed")!;
  assert.equal(failed.data.errorType, "RESOURCE_MISSING");
  const parsed = JSON.parse(toolMessages(h.primary.requests[1])[0]!);
  assert.equal(parsed.errorType, "RESOURCE_MISSING");
  assert.ok(parsed.workspace.entries.includes("notes.txt"));
  assert.match(parsed.guidance, /Do not invent an unrelated path/);
  assert.equal(parsed.errorType === "INVALID_ARGUMENTS", false);
  assert.equal(parsed.errorType === "EXECUTION_FAILED", false);
});

test("an executed failure still escalates after three in a row", async () => {
  const h = harness([
    [
      call("a", { path: "index.html" }, "probe_disk"),
      call("b", { path: "index.html" }, "probe_disk"),
      call("c", { path: "index.html" }, "probe_disk"),
      { delta: "", done: true },
    ],
  ]);
  h.registry.register({
    name: "probe_disk",
    description: "probe",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    defaultPermission: "allowed",
    async execute() {
      return { ok: false, error: "disk full" };
    },
  });
  const runId = h.runtime.start(h.root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await settle(h.store, runId), "completed");
  const failed = h.store.get(runId)!.events.filter((e) => e.type === "tool.failed");
  assert.equal(failed.length, 3);
  assert.ok(failed.every((e) => e.data.errorType === "EXECUTION_FAILED"));
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "route.escalated"), true);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "model.escalated"), true);
});
