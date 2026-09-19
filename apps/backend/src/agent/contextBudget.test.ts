// apps/backend/src/agent/contextBudget.test.ts
//
// The invariant under test is structural, not cosmetic: OpenAI-style APIs
// reject a `tool` message whose matching `assistant` tool_calls turn is not
// present before it. A compaction bug here does not degrade quality, it
// produces a hard HTTP 400 partway through a long run — the exact situation
// compaction exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@orvyn/ai-core";
import {
  clampToolOutput,
  compactConversation,
  estimateConversationTokens,
  estimateTokens,
} from "./contextBudget";

/**
 * Asserts the one rule the wire format enforces: every tool reply is preceded
 * by an assistant turn that actually requested that call id.
 */
function assertNoOrphanToolMessages(messages: AIMessage[]): void {
  const requested = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) requested.add(tc.id);
    }
    if (m.role === "tool") {
      assert.ok(
        m.toolCallId && requested.has(m.toolCallId),
        `orphaned tool message (toolCallId=${m.toolCallId}) — no preceding assistant tool_calls turn`
      );
    }
  }
}

/** Builds a conversation of `turns` assistant+tool exchanges of a given size. */
function buildConversation(turns: number, outputChars: number): AIMessage[] {
  const messages: AIMessage[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Refactor the auth module." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "assistant",
      content: `Step ${i}: reading a file.`,
      toolCalls: [{ id: `call_${i}`, name: "read_file", arguments: { path: `src/file${i}.ts` } }],
    });
    messages.push({
      role: "tool",
      name: "read_file",
      toolCallId: `call_${i}`,
      content: "x".repeat(outputChars),
    });
  }
  return messages;
}

test("leaves a conversation that already fits untouched", () => {
  const messages = buildConversation(3, 100);
  const result = compactConversation(messages, 1_000_000);

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages, "should return the same array reference when no work is needed");
  assert.equal(result.droppedTurns, 0);
  assert.equal(result.elidedResults, 0);
});

test("elides old tool output before dropping any turn", () => {
  const messages = buildConversation(10, 4_000);
  const budget = Math.floor(estimateConversationTokens(messages) / 2);

  const result = compactConversation(messages, budget);

  assert.equal(result.compacted, true);
  assert.ok(result.elidedResults > 0, "should have elided at least one stale tool result");
  assert.ok(result.tokensAfter < result.tokensBefore, "compaction must actually reduce the token count");
  assertNoOrphanToolMessages(result.messages);
});

test("never orphans a tool message, even under extreme pressure", () => {
  const messages = buildConversation(40, 8_000);

  // Squeeze hard enough to force phase 2 (whole-turn dropping).
  const result = compactConversation(messages, 2_000);

  assert.equal(result.compacted, true);
  assert.ok(result.droppedTurns > 0, "extreme pressure should drop whole turns");
  assertNoOrphanToolMessages(result.messages);
});

test("preserves the system prompt and the original instruction", () => {
  const messages = buildConversation(30, 8_000);
  const result = compactConversation(messages, 2_000);

  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, "You are a coding agent.");
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[1].content, "Refactor the auth module.");
});

test("keeps the most recent exchanges intact", () => {
  const messages = buildConversation(20, 4_000);
  const result = compactConversation(messages, 6_000, 3);

  // The final tool result is the agent's working memory; losing it makes the
  // model repeat the call it just made.
  const lastTool = [...result.messages].reverse().find((m) => m.role === "tool");
  assert.ok(lastTool, "a recent tool message should survive");
  assert.equal(lastTool!.content, "x".repeat(4_000), "the newest tool output must not be elided");
});

test("tells the model that history was removed", () => {
  const messages = buildConversation(30, 8_000);
  const result = compactConversation(messages, 2_000);

  const marker = result.messages.find((m) => m.content.includes("removed from this conversation"));
  assert.ok(marker, "a dropped-history marker should be present so the model knows its view is partial");
});

test("a conversation with no tool turns is still handled", () => {
  const messages: AIMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "y".repeat(80_000) },
  ];
  // The preamble alone exceeds the budget and is protected, so this must
  // terminate and return something valid rather than looping or throwing.
  const result = compactConversation(messages, 1_000);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[1].role, "user");
  assertNoOrphanToolMessages(result.messages);
});

test("clampToolOutput keeps the head and the tail", () => {
  const output = `START${"m".repeat(50_000)}END`;
  const { text, truncated } = clampToolOutput(output, 1_000);

  assert.equal(truncated, true);
  assert.ok(text.startsWith("START"), "the beginning of the output must survive");
  assert.ok(text.endsWith("END"), "the end — where errors and summaries live — must survive");
  assert.ok(text.length < output.length);
  assert.match(text, /characters omitted/);
});

test("clampToolOutput leaves short output exactly as-is", () => {
  const output = "all good";
  const { text, truncated } = clampToolOutput(output, 1_000);

  assert.equal(truncated, false);
  assert.equal(text, output);
});

test("token estimates scale with length and treat empty input as zero", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("a".repeat(3_600)) >= 900);
  assert.ok(estimateTokens("a".repeat(360)) < estimateTokens("a".repeat(3_600)));
});

test("a huge base64 image attachment does not blow up the estimate", () => {
  // Counting b64 characters as tokens would over-estimate by orders of
  // magnitude and send the runtime into permanent compaction.
  const withImage: AIMessage[] = [
    { role: "user", content: "what is this", attachments: [{ kind: "image", name: "s.png", b64: "A".repeat(500_000) }] },
  ];
  assert.ok(estimateConversationTokens(withImage) < 5_000);
});
