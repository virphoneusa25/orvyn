// Tool-call arguments survive every provider wire shape intact, and
// unreadable arguments are never turned into a valid-looking {}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { OpenAICompatibleAdapter, parseToolArguments, rawArguments, type ModelConfig } from "@orvyn/ai-core";
import { MALFORMED_CALL_LIMIT, friendlyArgumentFailure, unreadableArgumentsPayload } from "./toolFailure";

const CSS = Array.from({ length: 900 }, (_, i) => `.block-${i} { color: #${(i * 4099).toString(16).padStart(6, "0").slice(0, 6)}; padding: ${i % 40}px; }`).join("\n");

test("argument text is parsed, never replaced with {}", () => {
  assert.deepEqual(parseToolArguments('{"path":"styles.css","content":"a"}'), { args: { path: "styles.css", content: "a" } });
  assert.deepEqual(parseToolArguments('```json\n{"path":"a.css","content":"x"}\n```').args, { path: "a.css", content: "x" });
  assert.deepEqual(parseToolArguments('{"path":"a.css","content":"x",}').args, { path: "a.css", content: "x" });
  assert.deepEqual(parseToolArguments(JSON.stringify(JSON.stringify({ path: "a.css", content: "x" }))).args, { path: "a.css", content: "x" }, "double-encoded");
  assert.deepEqual(parseToolArguments(""), { args: {} }, "a tool with no arguments");
  const cut = parseToolArguments('{"path":"styles.css","content":".hero { color: red; } .cards { dis', "length");
  assert.deepEqual(cut.args, {});
  assert.equal(cut.error?.reason, "truncated");
  assert.deepEqual(cut.error?.keys, ["path", "content"]);
  assert.equal(cut.error?.path, "styles.css");
  const cutNoReason = parseToolArguments('{"path":"styles.css","content":"abc');
  assert.equal(cutNoReason.error?.reason, "truncated", "unbalanced text is a cut-off call even without finish_reason");
  assert.equal(parseToolArguments("path=styles.css").error?.reason, "invalid_json");
});

test("rawArguments reads every provider field shape", () => {
  assert.equal(rawArguments({ function: { arguments: '{"a":1}' } }), '{"a":1}');
  assert.equal(rawArguments({ function: { arguments: { a: 1 } } }), '{"a":1}', "object arguments (some GLM/Qwen servers)");
  assert.equal(rawArguments({ input: { a: 1 } }), '{"a":1}');
  assert.equal(rawArguments({ args: { a: 1 } }), '{"a":1}');
  assert.equal(rawArguments({ parameters: '{"a":1}' }), '{"a":1}');
  assert.equal(rawArguments({ tool_input: { a: 1 } }), '{"a":1}');
});

/** A fake provider that streams one write_file call in a given wire style. */
async function streamWith(style: string): Promise<{ calls: any[]; server: Server }> {
  const args = JSON.stringify({ path: "styles.css", content: CSS });
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const pieces = args.match(/[\s\S]{1,97}/g)!;
      if (style === "openai" || style === "nebius-vllm" || style === "fireworks") {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } }] } }] });
        for (const p of pieces) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else if (style === "kimi") {
        // Kimi: ids like functions.write_file:0, name repeated in every chunk.
        for (const p of pieces) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "functions.write_file:0", function: { name: "write_file", arguments: p } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else if (style === "glm-object") {
        // Some GLM/Qwen servers send the arguments as an already-parsed object in one chunk.
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_g", function: { name: "write_file", arguments: JSON.parse(args) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else if (style === "qwen-no-index") {
        // Two calls, no index fields: must not be glued together.
        send({ choices: [{ index: 0, delta: { tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"index.html"}' } }] } }] });
        for (const [i, p] of pieces.entries()) send({ choices: [{ index: 0, delta: { tool_calls: [{ ...(i === 0 ? { id: "c2", function: { name: "write_file", arguments: p } } : { function: { arguments: p } }) }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else if (style === "message-only") {
        // llama.cpp-style: the whole call on choices[0].message.
        send({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "m1", function: { name: "write_file", arguments: args } }] }, finish_reason: "tool_calls" }] });
      } else if (style === "truncated") {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "write_file", arguments: args.slice(0, 5000) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const config: ModelConfig = { id: "t", name: "t", provider: "openai-compatible", endpoint: `http://127.0.0.1:${port}`, contextWindow: 128000, maxOutputTokens: 16384, defaultTemperature: 0, defaultTopP: 1, streaming: true, capabilities: { chat: true, code: true, agent: true, tools: true, vision: false, embeddings: false, completion: true, image: false } } as ModelConfig;
  const adapter = new OpenAICompatibleAdapter(config);
  const calls: any[] = [];
  for await (const chunk of adapter.stream({ messages: [{ role: "user", content: "x" }], stream: true, tools: [{ name: "write_file", description: "", parameters: {} }, { name: "read_file", description: "", parameters: {} }] } as any)) {
    if (chunk.toolCall) calls.push(chunk.toolCall);
  }
  return { calls, server };
}

for (const style of ["openai", "nebius-vllm", "fireworks", "kimi", "glm-object", "message-only"]) {
  test(`provider wire style ${style}: a large write_file arrives intact`, async () => {
    const { calls, server } = await streamWith(style);
    server.close();
    const write = calls.find((c) => c.name === "write_file");
    assert.ok(write, JSON.stringify(calls.map((c) => c.name)));
    assert.equal(write.argumentsError, undefined);
    assert.equal(write.arguments.path, "styles.css");
    assert.equal(write.arguments.content, CSS, `content preserved (${CSS.length} chars)`);
  });
}

test("calls without an index are not glued together", async () => {
  const { calls, server } = await streamWith("qwen-no-index");
  server.close();
  assert.deepEqual(calls.map((c) => c.name), ["read_file", "write_file"]);
  assert.equal(calls[0].arguments.path, "index.html");
  assert.equal(calls[1].arguments.content, CSS);
});

test("a call cut off at the output limit arrives flagged, not as {}", async () => {
  const { calls, server } = await streamWith("truncated");
  server.close();
  assert.equal(calls[0].argumentsError?.reason, "truncated");
  assert.equal(calls[0].argumentsError?.path, "styles.css");
  const p = unreadableArgumentsPayload({ tool: "write_file", ...calls[0].argumentsError, schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } as any });
  const model = JSON.parse(p.modelText);
  assert.equal(model.code, "INVALID_TOOL_ARGUMENTS");
  assert.match(model.guidance, /append": true/);
  assert.equal(p.error, "ORION couldn't apply the stylesheet change because the file-edit request was malformed.");
});

test("an identical malformed call is answered once, then blocked", () => {
  assert.equal(MALFORMED_CALL_LIMIT, 2);
  assert.equal(friendlyArgumentFailure("write_file", "index.html"), "ORION couldn't apply the page change because the file-edit request was malformed.");
});
