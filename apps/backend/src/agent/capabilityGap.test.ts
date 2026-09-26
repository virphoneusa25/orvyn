import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityForToolName, capabilityGapFor, claimsToolUnavailable, emptySearchResult, unwrapParallelCalls } from "./capabilityGap";

const known = (n: string) => ["web_search", "fetch_url", "read_file"].includes(n);

test("multi_tool_use.parallel is unwrapped into the real calls", () => {
  const calls = unwrapParallelCalls(
    [{ id: "c1", name: "multi_tool_use.parallel", arguments: { tool_uses: [
      { recipient_name: "functions.web_search", parameters: { query: "KEXP radio site" } },
      { recipient_name: "functions.web_search", parameters: { query: "NTS radio site" } },
    ] } }],
    known,
  );
  assert.deepEqual(calls.map((c) => [c.id, c.name, c.arguments.query]), [["c1_0", "web_search", "KEXP radio site"], ["c1_1", "web_search", "NTS radio site"]]);
  const multi = unwrapParallelCalls([{ id: "c2", name: "multi_search", arguments: { queries: ["a", "b"] } }], known);
  assert.deepEqual(multi.map((c) => c.arguments.query), ["a", "b"]);
  const plain = unwrapParallelCalls([{ id: "c3", name: "read_file", arguments: { path: "x" } }], known);
  assert.equal(plain[0]!.name, "read_file");
});

test("capability gaps: invented tools, blocked search, missing keys — not ordinary failures", () => {
  assert.equal(capabilityGapFor({ toolName: "google_search", error: "", unknownTool: true }), "search the web");
  assert.equal(capabilityGapFor({ toolName: "send_email", error: 'Unknown tool "send_email"' }), "send and read email");
  assert.equal(capabilityGapFor({ toolName: "web_search", error: "DuckDuckGo HTTP 403" }), "search the web");
  assert.equal(capabilityGapFor({ toolName: "web_search", error: "Search failed: fetch failed" }), "search the web");
  assert.equal(capabilityGapFor({ toolName: "mcp.github.create_pr", error: "server not connected" }), "work with GitHub");
  assert.equal(capabilityGapFor({ toolName: "read_file", error: "ENOENT: no such file" }), null);
  assert.equal(capabilityGapFor({ toolName: "terminal", error: "exit 1: 2 failing tests" }), null);
  assert.equal(capabilityForToolName("browser_search"), "search the web");
  assert.ok(emptySearchResult("web_search", "(no results parsed — try fetch_url on a specific page)"));
  assert.ok(!emptySearchResult("web_search", "1. KEXP\n   https://kexp.org"));
});

test("replies that blame a tool are caught; normal replies are not", () => {
  assert.ok(claimsToolUnavailable("I tried to search live websites, but web search isn't available in this session."));
  assert.ok(claimsToolUnavailable("The first search batch didn't run because the multi-search wrapper couldn't resolve the search tool."));
  assert.ok(claimsToolUnavailable("I don't have access to a web search tool, so here are examples from memory."));
  assert.ok(claimsToolUnavailable("I'm unable to browse the internet right now."));
  assert.ok(!claimsToolUnavailable("I searched the web and read 4 pages. KEXP and NTS are good examples."));
  assert.ok(!claimsToolUnavailable("The Now Playing feed is not available when the stream is offline, so show a fallback message."));
});
