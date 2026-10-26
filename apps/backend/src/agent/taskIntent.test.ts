import { test } from "node:test";
import assert from "node:assert/strict";
import { inferTaskIntent } from "./taskIntent";

test("MCP server phrases do not falsely require an SSH server", () => {
  for (const prompt of [
    "Configure an MCP server and list its available tools",
    "Build a local MCP server in Node.js and run unit tests",
    "Call mcp_list on the configured Model Context Protocol server",
    "Fix a bug in the stdio server fixture and run tests",
  ]) {
    const intent = inferTaskIntent(prompt);
    assert.equal(intent.requiresRemoteResource, false, `MCP/local server prompt must not require remote SSH: ${prompt}`);
    assert.equal(intent.resourceRequirements.includes("server"), false, `must not require 'server' resource: ${prompt}`);
    assert.notEqual(intent.category, "server", `category must not be 'server': ${prompt}`);
  }
});

test("genuine SSH / remote server tasks still require a server resource", () => {
  for (const prompt of [
    "SSH into my production server and check uptime",
    "Log into my configured test server and tell me its hostname and uptime.",
  ]) {
    const intent = inferTaskIntent(prompt);
    assert.equal(intent.requiresRemoteResource, true, `expected remote resource for: ${prompt}`);
    assert.equal(intent.resourceRequirements.includes("server"), true, `expected 'server' resource for: ${prompt}`);
  }
});

test("Task classification: coding task properly identified and requires workspace", () => {
  const intent = inferTaskIntent("Fix the bug in src/auth.ts and run the unit tests");
  assert.equal(intent.taskType, "coding");
  assert.equal(intent.requiresWorkspace, true);
});

test("Task classification: browser research task does not require workspace and requires browser", () => {
  const intent = inferTaskIntent("can you review www.virphoneusa.com and tell me how to improve it");
  assert.equal(intent.taskType, "browser_research");
  assert.equal(intent.requiresWorkspace, false);
  assert.equal(intent.requiresBrowser, true);
});

test("Task classification: desktop task identifies desktop requirement", () => {
  const intent = inferTaskIntent("open notepad on my screen and check what is visible on this window");
  assert.equal(intent.taskType, "desktop");
  assert.equal(intent.requiresDesktop, true);
});

test("Task classification: hybrid task identifies both workspace and browser requirements", () => {
  const intent = inferTaskIntent("build the new hero component in src/components/Hero.tsx and check the website in browser");
  assert.equal(intent.taskType, "hybrid");
  assert.equal(intent.requiresWorkspace, true);
  assert.equal(intent.requiresBrowser, true);
});

test("Task classification: informational task requires neither workspace nor browser", () => {
  const intent = inferTaskIntent("what is PostgreSQL and how does b-tree indexing work?");
  assert.equal(intent.taskType, "informational");
  assert.equal(intent.informational, true);
  assert.equal(intent.requiresWorkspace, false);
});

