import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnostics,
  buildJsonTranscript,
  buildMarkdownTranscript,
  conversationHasContent,
  redactSecrets,
} from "./shareTranscript.ts";

const sample = {
  title: "Fix login",
  runId: "c81e0a95-aaaa-bbbb-cccc-ddddeeeeffff",
  messages: [
    { role: "user" as const, content: "Fix the login bug. API key sk-secret-123456 and Bearer abc.def" },
    { role: "assistant" as const, content: "Updated auth.ts. orvsess_do-not-copy" },
  ],
  events: [
    { type: "tool.completed", data: { tool: "read_file", preview: "export function login() {}" } },
    { type: "reasoning.delta", data: { text: "hidden chain of thought" } },
    { type: "file.edit", data: { preview: { path: "auth.ts", additions: 2, deletions: 1 } } },
    { type: "usage", data: { promptTokens: 999 } },
  ],
};

test("markdown transcript includes user, assistant, and important tool results", () => {
  const md = buildMarkdownTranscript(sample);
  assert.match(md, /Fix the login bug/);
  assert.match(md, /Updated auth\.ts/);
  assert.match(md, /Tool read_file/);
  assert.match(md, /Edited auth\.ts/);
  assert.match(md, /c81e0a95-aaaa-bbbb-cccc-ddddeeeeffff/);
});

test("transcripts never include secrets or hidden reasoning", () => {
  const md = buildMarkdownTranscript(sample);
  const json = buildJsonTranscript(sample);
  for (const text of [md, json]) {
    assert.equal(text.includes("sk-secret-123456"), false);
    assert.equal(text.includes("orvsess_"), false);
    assert.equal(text.includes("Bearer abc"), false);
    assert.equal(text.includes("hidden chain of thought"), false);
    assert.equal(text.includes("promptTokens"), false);
    assert.match(text, /\[redacted\]/);
  }
});

test("redactSecrets strips private keys and ORVYN env keys", () => {
  const raw = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nORVYN_API_KEY=supersecret";
  const clean = redactSecrets(raw);
  assert.equal(clean.includes("supersecret"), false);
  assert.equal(clean.includes("BEGIN PRIVATE KEY"), false);
});

test("diagnostics omit tokens and only list support-safe fields", () => {
  const text = buildDiagnostics({
    runId: "c81e0a95-aaaa",
    backendHost: "orvyn.virphoneusa.com",
    cloudMode: true,
    workspaceName: "phase5-reset-mail",
    engineState: "ready",
  });
  assert.match(text, /c81e0a95-aaaa/);
  assert.match(text, /orvyn\.virphoneusa\.com/);
  assert.equal(text.toLowerCase().includes("token"), false);
  assert.equal(text.toLowerCase().includes("api key"), false);
});

test("conversationHasContent is false for an empty chat", () => {
  assert.equal(conversationHasContent({ messages: [] }), false);
  assert.equal(conversationHasContent({ messages: [{ role: "user", content: "hi" }] }), true);
});
