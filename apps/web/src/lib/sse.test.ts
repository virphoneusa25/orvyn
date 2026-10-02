import assert from "node:assert/strict";
import test from "node:test";
import { consumeSse, parseSseFrame, readSseStream } from "./sse.ts";

test("SSE frames yield JSON even when comments and split data lines are present", () => {
  const { events, rest } = consumeSse(": hb\n\ndata: {\"type\":\"message.delta\",\"data\":{\"content\":\"Hi\"}}\n\ndata: {\"type\":\"run.completed\"}\n\n");
  assert.equal(rest, "");
  assert.deepEqual(events, [
    { type: "message.delta", data: { content: "Hi" } },
    { type: "run.completed" },
  ]);
  assert.equal(parseSseFrame(": hb"), undefined);
});

test("an incomplete frame stays in the buffer until the blank line arrives", () => {
  const first = consumeSse('data: {"type":"message.delta"');
  assert.equal(first.events.length, 0);
  assert.match(first.rest, /message.delta/);
  const second = consumeSse(`${first.rest},"data":{"content":"ok"}}\n\n`);
  assert.deepEqual(second.events, [{ type: "message.delta", data: { content: "ok" } }]);
});

test("a stream that ends without a trailing blank line still delivers the last event", async () => {
  const seen: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"message.delta","data":{"content":"A"}}\n\ndata: {"type":"run.completed"}'));
      controller.close();
    },
  });
  await readSseStream(body, (event) => seen.push(event));
  assert.deepEqual(seen, [
    { type: "message.delta", data: { content: "A" } },
    { type: "run.completed" },
  ]);
});
