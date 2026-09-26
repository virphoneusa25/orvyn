// apps/desktop/src/renderer/orvynIntent.test.ts
//
// The "hi becomes a broken mission" regression, pinned. Runs with Node's
// built-in type stripping: `node --test apps/desktop/src/renderer/orvynIntent.test.ts`.
// Pure module — no DOM, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backendModeForIntent, belongsInCloudStorage, classifyFileRequest, classifyIntent, looksLikeGeneratedFileRequest } from "./orvynIntent.ts";

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
  assert.equal(classifyFileRequest("create test-output.txt containing hello"), "create-workspace");
});

test("polite requests to create or inspect artifacts use tools", () => {
  for (const prompt of ["Can you create a Word document?", "Please write a report", "Could you review this PDF?", "Make a spreadsheet"]) {
    assert.equal(classifyIntent(prompt,"auto"),"code");
  }
});

test("a login or SSH request is an engineering run, not a chat refusal", () => {
  assert.equal(classifyIntent("Create a file named hello.txt containing exactly hello world, read the file back, and tell me what it contains.", "auto"), "code");
  assert.equal(looksLikeGeneratedFileRequest("Create a file named hello.txt containing exactly hello world, read the file back, and tell me what it contains."), false);
  assert.equal(classifyIntent("Run node --version and tell me the exact version returned.", "auto"), "code");
  assert.equal(classifyIntent("CAN YOU LOGIN TO MY SERVER?", "auto"), "code");
  assert.equal(classifyIntent("Can you ssh into the box and check the logs?", "auto"), "code");
  assert.equal(classifyIntent("what can you actually do?", "auto"), "chat");
  assert.equal(classifyIntent("hi, what can you actually do? Can you co-work yet?", "auto"), "chat");
});

test("a named text or code file stays in the open folder, generated deliverables go to Cloud storage", () => {
  for (const p of [
    "Create a test.txt file with the word test in it",
    "Create a test.txt document with test in it and save it",
    "Write a report.md summarizing the project",
    "Save the notes to notes.txt",
    "Make an index.html page with a logo",
  ]) assert.equal(belongsInCloudStorage(p), false, p);
  for (const p of [
    "Generate a VirPhone logo as a PNG",
    "Create a Word document with my resume",
    "Make a PDF report of last month",
    "Create a spreadsheet of expenses",
  ]) assert.equal(belongsInCloudStorage(p), true, p);
});

test("an explicit request for the cloud goes to ORVYN Cloud even with a folder open", () => {
  for (const p of ["Create test-cloud.txt in a cloud workspace.", "Save notes.md to ORVYN Cloud", "Create hello.txt in the cloud"]) {
    assert.equal(belongsInCloudStorage(p), true, p);
  }
  for (const p of ["Create test-local.txt.", "Create notes.md, not in the cloud", "Don't use cloud, create a.txt here"]) {
    assert.equal(belongsInCloudStorage(p), false, p);
  }
});

test("auto: questions go to chat (which researches on its own); research assignments run as research", async () => {
  const { needsWebResearch } = await import("./orvynIntent.ts");
  for (const p of ["What is the latest Node.js LTS version?", "Who is the current CEO of Nvidia?"]) {
    assert.equal(classifyIntent(p, "auto"), "chat", p);
    assert.equal(needsWebResearch(p), true, p);
  }
  assert.equal(classifyIntent("Research the best VoIP softswitches and cite sources", "auto"), "research");
  assert.equal(classifyIntent("What is 2+2?", "auto"), "chat");
  assert.equal(classifyIntent("Create hello.txt", "auto"), "code");
  assert.equal(classifyIntent("Build a landing page with the newest iPhone prices", "auto"), "code", "build work stays an agent run (it researches inside the run)");
});
