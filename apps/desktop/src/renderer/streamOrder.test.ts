import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionStreamMessages } from "./streamOrder.ts";

test("a follow-up sent after the run renders after the run, not above it", () => {
  const runStart = 1_000_000;
  const { earlier, later } = partitionStreamMessages(
    [
      { role: "user", content: "find the BLF bug", createdAt: runStart - 20 },
      { role: "assistant", content: "I'll trace the BLF presence flow", createdAt: runStart - 10 },
      { role: "user", content: "CAN YOU LOGIN TO MY SERVER?", createdAt: runStart + 5_000 },
      { role: "assistant", content: "I can help you connect", createdAt: runStart + 5_001 },
    ],
    [{ type: "run.started", timestamp: runStart }, { type: "message.delta", timestamp: runStart + 30 }],
  );
  assert.deepEqual(earlier.map((m) => m.content), ["find the BLF bug", "I'll trace the BLF presence flow"]);
  assert.deepEqual(later.map((m) => m.content), ["CAN YOU LOGIN TO MY SERVER?", "I can help you connect"]);
});

test("the only new turn on an existing mission is entirely below the run", () => {
  const runStart = 1_000_000;
  const { earlier, later } = partitionStreamMessages(
    [
      { content: "CAN YOU LOGIN TO MY SERVER?", createdAt: runStart + 5_000 },
      { content: "I can help you connect", createdAt: runStart + 5_001 },
    ],
    [{ type: "run.started", timestamp: runStart }],
  );
  assert.deepEqual(earlier, []);
  assert.equal(later[0].content, "CAN YOU LOGIN TO MY SERVER?");
  assert.equal(later[1].content, "I can help you connect");
});

test("a chat with no attached run stays oldest-first", () => {
  const messages = [
    { content: "first", createdAt: 1 },
    { content: "second", createdAt: 2 },
  ];
  const { earlier, later } = partitionStreamMessages(messages, []);
  assert.equal(later.length, 0);
  assert.deepEqual(earlier, messages);
});

test("messages saved before createdAt existed stay above the run", () => {
  const { earlier, later } = partitionStreamMessages(
    [{ content: "legacy" }, { content: "new", createdAt: 200 }],
    [{ type: "run.started", timestamp: 100 }],
  );
  assert.deepEqual(earlier.map((m) => m.content), ["legacy"]);
  assert.deepEqual(later.map((m) => m.content), ["new"]);
});

import { threadTimeline } from "./streamOrder.ts";

test("earlier runs of the thread and chat turns interleave in the order they happened", () => {
  const t = threadTimeline(
    [{ role: "user", content: "hi", createdAt: 100 }, { role: "assistant", content: "hello", createdAt: 110 }],
    [
      { runId: "r2", createdAt: 300, instruction: "now read it", status: "completed", events: [] },
      { runId: "r1", createdAt: 200, instruction: "create hello.txt", status: "completed", events: [] },
    ],
  );
  assert.deepEqual(t.map((e) => (e.kind === "run" ? e.run.runId : (e.message as { content: string }).content)), ["hi", "hello", "r1", "r2"]);
});
