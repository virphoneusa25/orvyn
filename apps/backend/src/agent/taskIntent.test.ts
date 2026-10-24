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
