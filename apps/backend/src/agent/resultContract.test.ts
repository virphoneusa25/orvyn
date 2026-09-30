import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_RESULT_TOOL, settlementCriteria, settleResult } from "./resultContract";

const WEBSITE_EVENTS = [
  { type: "file.created", data: { path: "index.html" } },
  { type: "preview.verified", data: { url: "https://preview.example/site" } },
  { type: "verification.completed", data: { verdict: "PASS", checks: [{ name: "browser", status: "pass" }] } },
];

test("a completed request with every required criterion passing is accepted", () => {
  const criteria = settlementCriteria({
    instruction: "build a website",
    events: WEBSITE_EVENTS,
    needsArtifact: false,
    needsWorkspaceWrite: false,
    needsTests: false,
    website: true,
    needsVisual: false,
    verifierVerdict: "PASS",
    implementationWork: true,
  });
  const verdict = settleResult({ request: { status: "completed", summary: "done" }, criteria });
  assert.equal(verdict.accepted, true);
  if (verdict.accepted) assert.equal(verdict.status, "completed");
});

test("the reported bug: preview error + 'not fully done' can never settle as completed", () => {
  const criteria = settlementCriteria({
    instruction: "build a website",
    events: [
      { type: "file.created", data: { path: "index.html" } },
      { type: "preview.failed", data: { issues: ["styles.css → 404"] } },
      { type: "verification.completed", data: { verdict: "FAIL", checks: [{ name: "browser", status: "fail" }], findings: [{ severity: "blocker" }] } },
    ],
    needsArtifact: false,
    needsWorkspaceWrite: false,
    needsTests: false,
    website: true,
    needsVisual: false,
    verifierVerdict: "FAIL",
    implementationWork: true,
  });
  const verdict = settleResult({ request: { status: "completed", summary: "done" }, criteria });
  assert.equal(verdict.accepted, false);
  if (verdict.accepted) return;
  assert.equal(verdict.error, "CompletionRejected");
  const ids = verdict.incomplete.map((c) => c.id);
  assert.ok(ids.includes("preview"));
  assert.ok(ids.includes("console"));
  assert.ok(ids.includes("verification"));
  const payload = JSON.parse(verdict.modelText);
  assert.equal(payload.error, "CompletionRejected");
  assert.match(payload.message, /verification criteria remain incomplete/i);
});

test("the criteria matrix names exactly what is missing (build pass / preview pass / console fail / mobile not run)", () => {
  const criteria = settlementCriteria({
    instruction: "build a responsive website",
    events: [
      { type: "file.created", data: { path: "index.html" } },
      { type: "tool.input", data: { callId: "c1", input: { command: "npm test" } } },
      { type: "tool.completed", data: { callId: "c1", tool: "terminal" } },
      { type: "preview.verified", data: { url: "https://preview.example/site" } },
      { type: "verification.completed", data: { verdict: "PARTIAL", checks: [{ name: "browser", status: "fail" }] } },
    ],
    needsArtifact: false,
    needsWorkspaceWrite: false,
    needsTests: true,
    website: true,
    needsVisual: false,
    verifierVerdict: "PARTIAL",
    implementationWork: true,
  });
  const byId = new Map(criteria.map((c) => [c.id, c]));
  assert.equal(byId.get("tests")?.status, "pass");
  assert.equal(byId.get("preview")?.status, "pass");
  assert.equal(byId.get("console")?.status, "fail");
  assert.equal(byId.get("mobile")?.status, "not_run");
  const verdict = settleResult({ request: { status: "completed", summary: "done" }, criteria });
  assert.equal(verdict.accepted, false);
});

test("a failed last test run blocks completion even after an earlier pass", () => {
  const events = [
    { type: "tool.input", data: { callId: "a", input: { command: "npm test" } } },
    { type: "tool.completed", data: { callId: "a", tool: "terminal" } },
    { type: "tool.input", data: { callId: "b", input: { command: "npm test" } } },
    { type: "tool.failed", data: { callId: "b", tool: "terminal" } },
  ];
  const criteria = settlementCriteria({
    instruction: "fix it and run the tests",
    events,
    needsArtifact: false, needsWorkspaceWrite: false, needsTests: true,
    website: false, needsVisual: false, implementationWork: true, verifierVerdict: "PASS",
  });
  assert.equal(criteria.find((c) => c.id === "tests")?.status, "fail");
  assert.equal(settleResult({ request: { status: "completed", summary: "x" }, criteria }).accepted, false);
});

test("honest partial/blocked/failed requests settle as asked", () => {
  for (const status of ["partial", "blocked", "failed"] as const) {
    const verdict = settleResult({ request: { status, summary: "s" }, criteria: [{ id: "x", required: true, status: "fail" }] });
    assert.equal(verdict.accepted, true);
    if (verdict.accepted) assert.equal(verdict.status, status);
  }
});

test("the terminal tool name is stable", () => {
  assert.equal(REPORT_RESULT_TOOL, "report_result");
});
