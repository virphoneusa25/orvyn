import { test } from "node:test";
import assert from "node:assert/strict";
import { researchSummary, sourcesFromActivity, stepsFromActivity } from "./researchSteps.ts";

const activity = [
  { id: "1", kind: "search" as const, status: "done" as const, query: "Brave Search API pricing", results: 9, found: [{ url: "https://brave.com/search/api/", title: "Brave API" }, { url: "https://x.com/a", title: "X" }] },
  { id: "2", kind: "read" as const, status: "done" as const, url: "https://www.anthropic.com/news/claude-sonnet-5", title: "Claude Sonnet 5" },
  { id: "3", kind: "read" as const, status: "done" as const, url: "https://brave.com/search/api", title: "Brave Search API" },
  { id: "4", kind: "read" as const, status: "failed" as const, url: "https://blocked.example/" },
];

test("research timeline: steps, summary and sources", () => {
  const steps = stepsFromActivity(activity);
  assert.deepEqual(steps.map((s) => [s.kind, s.label, s.domain ?? s.results]), [
    ["search", "Brave Search API pricing", 9],
    ["read", "https://www.anthropic.com/news/claude-sonnet-5", "anthropic.com"],
    ["read", "https://brave.com/search/api", "brave.com"],
    ["read", "https://blocked.example/", "blocked.example"],
  ]);
  assert.equal(researchSummary(steps, false), "Searched the web, read 2 pages");
  assert.equal(researchSummary([{ id: "1", kind: "search", status: "running", label: "x" }], true), "Searching the web…");
  const sources = sourcesFromActivity(activity);
  assert.deepEqual(sources.map((s) => [s.domain, s.kind]), [["anthropic.com", "read"], ["brave.com", "read"], ["x.com", "search"]]);
});
