// apps/desktop/src/renderer/orvynIntent.test.ts
//
// The "hi becomes a broken mission" regression, pinned. Runs with Node's
// built-in type stripping: `node --test apps/desktop/src/renderer/orvynIntent.test.ts`.
// Pure module — no DOM, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backendModeForIntent, classifyFileRequest, classifyIntent, looksLikeGeneratedFileRequest } from "./orvynIntent.ts";

test("greetings are CHAT in every mode — even CODE", () => {
  for (const mode of ["auto", "code", "server", "research", "deploy", "automate"] as const) {
    assert.equal(classifyIntent("hi", mode), "chat", `"hi" in ${mode} must classify as chat`);
    assert.equal(classifyIntent("hello!", mode), "chat");
    assert.equal(classifyIntent("thanks", mode), "chat");
    assert.equal(classifyIntent("good afternoon", mode), "chat");
  }
});

test("tiny-talk questions are CHAT even in explicit modes", () => {
  assert.equal(classifyIntent("how are you?", "code"), "chat");
  assert.equal(classifyIntent("what can you do?", "deploy"), "chat");
});

test("AUTO routes questions to chat and work to code", () => {
  assert.equal(classifyIntent("explain this project", "auto"), "chat");
  assert.equal(classifyIntent("tell me about Docker", "auto"), "chat");
  assert.equal(classifyIntent("Create a file named orvyn-test.md containing ORVYN is working.", "auto"), "code");
  assert.equal(
    classifyIntent("Inspect the authentication system, fix the login problem, run tests and verify.", "auto"),
    "code"
  );
});

test("explicit executable modes stay executable for real work", () => {
  assert.equal(classifyIntent("Fix the TypeScript error in Settings.tsx.", "code"), "code");
  assert.equal(classifyIntent("Check why the production API is failing and fix it.", "server"), "code");
  assert.equal(classifyIntent("Deploy this application to production with zero downtime.", "deploy"), "code");
});

test("research and automate modes route to their lanes", () => {
  assert.equal(classifyIntent("Research the architecture used by this project.", "research"), "research");
  assert.equal(classifyIntent("Check the server every morning.", "automate"), "automate");
  assert.equal(backendModeForIntent("research"), "research");
  assert.equal(backendModeForIntent("automate"), "agent");
  assert.equal(backendModeForIntent("code"), "agent");
  assert.equal(backendModeForIntent("chat"), null);
});


test("logo and PNG requests are generated-file work, not a local-folder prerequisite", () => {
  assert.equal(looksLikeGeneratedFileRequest("generate a virphone logo .png"), true);
  assert.equal(looksLikeGeneratedFileRequest("Create a logo for Virphone"), true);
  assert.equal(looksLikeGeneratedFileRequest("fix the login bug"), false);
  assert.equal(classifyFileRequest("Generate a simple VirPhone logo and provide it as a PNG."), "generate-artifact");
  assert.equal(classifyFileRequest("create test-output.txt containing hello"), "generate-artifact");
});

test("polite requests to create or inspect artifacts use tools", () => {
  for (const prompt of ["Can you create a Word document?", "Please write a report", "Could you review this PDF?", "Make a spreadsheet"]) {
    assert.equal(classifyIntent(prompt,"auto"),"code");
  }
});
