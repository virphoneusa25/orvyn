// A fresh website must be written, served, and checked in the browser.
// Prose that only announces the next step is not a turn of work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AIChunk, AIRequest, AIResponse, ModelConfig } from "@orvyn/ai-core";
import { ToolRegistry } from "../ai/ToolTypes";
import { makeListDirectoryTool, makeReadFileTool, makeWriteFileTool } from "../ai/tools/fileTools";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { RunStore } from "./events";
import { StreamingAgentRuntime } from "./StreamingAgentRuntime";

const PROMPT = "Build a simple one-page website with a hero, services, and contact section.";

const PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Harbor Studio</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header><h1>Harbor Studio</h1><p>A one-page studio site for design, build, and care.</p></header>
  <main>
    <section id="hero"><h2>Hero</h2><p>We design calm websites for small teams who want a clear first impression and a straightforward way to get in touch.</p></section>
    <section id="services"><h2>Services</h2><p>Brand, web, and product design. Each engagement starts with the work you already have and ends with a page you can publish.</p></section>
    <section id="contact"><h2>Contact</h2><p>Email studio@harbor.example or call the desk. We reply within two working days.</p></section>
  </main>
</body>
</html>
`;

const CSS = "body { color: #1a1a1a; font-family: Georgia, serif; margin: 0; }\n";

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

class FakeProvider {
  readonly config = CONFIG;
  readonly requests: AIRequest[] = [];
  constructor(private turns: AIChunk[][]) {}

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    this.requests.push(JSON.parse(JSON.stringify({ messages: request.messages })));
    const turn = this.turns.shift() ?? [{ delta: "Done.", done: true }];
    for (const chunk of turn) yield chunk;
  }

  async generate(): Promise<AIResponse> {
    return { content: "VERDICT: PASS\n- the page is present", finishReason: "stop" };
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

function prose(text: string): AIChunk[] {
  return [{ delta: text, done: true }];
}

function call(id: string, name: string, args: Record<string, unknown>): AIChunk[] {
  return [{ delta: `I'll ${name} now.`, toolCall: { id, name, arguments: args }, done: true }];
}

function browserResult(url: string) {
  return {
    ok: true,
    output: `opened ${url}`,
    meta: {
      browserSessionId: "browser-1",
      surface: "browser",
      browserSession: { url, consoleErrors: 0, networkErrors: 0, viewport: { preset: "desktop", width: 1280, height: 800 } },
    },
  };
}

function harness(root: string, turns: AIChunk[][]) {
  const registry = new ToolRegistry();
  registry.register(makeListDirectoryTool(root));
  registry.register(makeReadFileTool(root));
  registry.register(makeWriteFileTool(root));
  registry.register({
    name: "browser_open",
    description: "Open the shared browser",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    defaultPermission: "allowed",
    async execute(args) {
      return browserResult(String(args.url ?? ""));
    },
  });
  registry.register({
    name: "browser_screenshot",
    description: "Screenshot the shared browser",
    parameters: { type: "object", properties: { url: { type: "string" } } },
    defaultPermission: "allowed",
    async execute(args) {
      return {
        ...browserResult(String(args.url ?? "http://127.0.0.1:4570/preview")),
        meta: {
          ...browserResult(String(args.url ?? "http://127.0.0.1:4570/preview")).meta,
          browserScreenshot: { screenshotId: "shot-1", sessionId: "browser-1", width: 1280, height: 800, sha256: "abc" },
        },
      };
    },
  });
  const provider = new FakeProvider(turns);
  const store = new RunStore();
  const runtime = new StreamingAgentRuntime({
    router: { resolve: () => provider },
    registry: { get: (id: string) => (id === provider.config.id ? provider : undefined), list: () => [provider] },
  } as any, new ToolGateway(registry, new PermissionEngine()), store);
  return { runtime, store, provider };
}

async function waitFor(store: RunStore, runId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = store.get(runId)?.status;
    if (status && status !== "running" && status !== "awaiting_approval" && status !== "verifying") return status;
    await new Promise((r) => setTimeout(r, 15));
  }
  return store.get(runId)?.status ?? "unknown";
}

function bubbles(events: Array<{ type: string; data?: Record<string, unknown> }>): string[] {
  const items: string[] = [];
  let buf = "";
  for (const event of events) {
    if (event.type === "message.delta") buf += String(event.data?.content ?? "");
    else if (event.type === "message.completed") {
      if (buf.trim()) items.push(buf.trim());
      buf = "";
    } else if (event.type === "message.retracted") {
      if (buf) buf = "";
      else items.pop();
    }
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

test("a one-page website is written, served, and checked before the final answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-site-"));
  const h = harness(root, [
    prose("Let me check the workspace."),
    prose("The folder is empty. I need to supply the path and content. I'll now create the page."),
    call("list-1", "list_directory", { path: "." }),
    call("bad-write", "write_file", { path: "index.html" }),
    prose("I need to supply the path and content."),
    call("write-html", "write_file", { path: "index.html", content: PAGE }),
    call("write-css", "write_file", { path: "styles.css", content: CSS }),
    call("write-2", "write_file", { path: "index-2.html", content: PAGE.replace("Harbor Studio", "Harbor Two") }),
    call("write-3", "write_file", { path: "index-3.html", content: PAGE.replace("Harbor Studio", "Harbor Three") }),
    call("open-1", "browser_open", { url: "http://127.0.0.1:4570/preview" }),
    call("shot-1", "browser_screenshot", { url: "http://127.0.0.1:4570/preview" }),
    prose("Finished. The site is running and the Browser check passed."),
  ]);

  const runId = h.runtime.start(root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  const status = await waitFor(h.store, runId);
  const failure = h.store.get(runId)?.events.find((e) => e.type === "run.error");
  assert.equal(status, "completed", String(failure?.data?.message ?? status));

  const html = readFileSync(join(root, "index.html"), "utf8");
  const css = readFileSync(join(root, "styles.css"), "utf8");
  assert.match(html, /Harbor Three/);
  assert.equal(existsSync(join(root, "index-2.html")), false);
  assert.equal(existsSync(join(root, "index-3.html")), false);
  assert.match(html, /Hero/);
  assert.match(html, /Services/);
  assert.match(html, /Contact/);
  assert.match(css, /color/);

  const events = h.store.get(runId)!.events;
  const invalid = events.filter((e) => e.type === "tool.failed" && e.data?.errorType === "INVALID_ARGUMENTS");
  assert.equal(invalid.length, 1, "one missing-content write is corrected, not looped");
  assert.equal(events.some((e) => e.type === "run.error" && /repeated the same invalid arguments/i.test(String(e.data?.message ?? ""))), false);

  const available = events.filter((e) => e.type === "preview.available");
  assert.equal(available.length, 1);
  const previewUrl = String(available[0]?.data?.url ?? "");
  assert.match(previewUrl, /^https?:\/\//);
  const updates = events.filter((e) => e.type === "preview.updated");
  assert.ok(updates.length >= 1);
  assert.ok(updates.every((e) => e.data?.url === previewUrl));
  const revisions = updates.map((e) => Number(e.data?.revision));
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(new Set(revisions).size, revisions.length);
  assert.ok(events.some((e) => e.type === "browser.completed" && e.data?.tool === "browser_open"));
  assert.ok(events.some((e) => e.type === "browser.completed" && e.data?.tool === "browser_screenshot"));
  const verification = [...events].reverse().find((e) => e.type === "verification.completed");
  assert.equal(verification?.data?.verdict, "PASS");
  const checks = (verification?.data?.checks as { name: string; status: string }[] | undefined) ?? [];
  assert.ok(checks.some((c) => c.name === "browser" && c.status === "pass"));

  const phases = events.filter((e) => e.type === "website.phase").map((e) => e.data?.phase);
  assert.ok(phases.includes("planning"));
  assert.ok(phases.includes("implementing"));
  assert.ok(phases.includes("browser_verification"));
  assert.ok(phases.includes("completed"));

  const said = bubbles(events);
  assert.ok(said.length >= 1 && said.length <= 6, said.join(" | "));
  assert.equal(said.some((line) => /Let me check|folder is empty|I'll now create|supply the path/i.test(line)), false);
  assert.equal(said.filter((line) => /page is not ready yet/i.test(line)).length <= 2, true);
  const finalAt = events.map((e) => e.type).lastIndexOf("message.completed");
  const before = events.slice(0, finalAt);
  assert.ok(before.some((e) => e.type === "file.created" && String(e.data?.path ?? "").endsWith("index.html")));
  assert.ok(before.some((e) => e.type === "preview.available"));
  assert.ok(before.some((e) => e.type === "browser.completed"));
  assert.ok(before.some((e) => e.type === "verification.completed" && e.data?.verdict === "PASS"));

  let buf = "";
  let bufAt = -1;
  let visibleStart = -1;
  events.forEach((event, index) => {
    if (event.type === "message.delta") {
      if (!buf) bufAt = index;
      buf += String(event.data?.content ?? "");
    } else if (event.type === "message.retracted") {
      buf = "";
      bufAt = -1;
    } else if (event.type === "message.completed" && buf.trim()) {
      visibleStart = bufAt;
      buf = "";
    }
  });
  const verifyAt = events.findIndex((event) => event.type === "verification.completed" && event.data?.verdict === "PASS");
  assert.ok(visibleStart > verifyAt, "the visible final starts after verification");
});

test("repeated website narration fails without claiming the site exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-site-narrate-"));
  const h = harness(root, [
    prose("Let me check."),
    prose("The folder is empty."),
    prose("I'll now create index.html."),
    prose("I'll create index.html now."),
  ]);
  const runId = h.runtime.start(root, PROMPT, undefined, "agent", undefined, [], undefined, undefined, { accessMode: "full_access" });
  assert.equal(await waitFor(h.store, runId), "error");
  const error = h.store.get(runId)!.events.find((e) => e.type === "run.error");
  assert.match(String(error?.data?.message ?? ""), /described the next step without calling a tool/);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "file.created"), false);
  assert.equal(h.store.get(runId)!.events.some((e) => e.type === "run.completed"), false);
  assert.throws(() => readFileSync(join(root, "index.html"), "utf8"));
});
