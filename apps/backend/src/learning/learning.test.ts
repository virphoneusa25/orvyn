import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { LocalStore } from "../persistence/LocalStore";
import { ExperienceStore, clusterFailures } from "./ExperienceStore";
import { evaluateRun } from "./RunEvaluator";
import { sanitizeLearningText, sanitizeRecord } from "./sanitize";
import { persistSkillCandidates, skillCandidatesFromExperiences } from "./skillCandidates";
import { persistDataset, trainingCandidates } from "./datasetBuilder";
import { ModelRegistry } from "./ModelRegistry";
import { bindTenantResource } from "../orgs/organization";
import type { Run } from "../agent/events";
import { buildRunReplay } from "./runReplay";

function ev(type: string, data: Record<string, unknown> = {}) {
  return { id: type, sequence: 1, type, timestamp: Date.now(), data } as Run["events"][number];
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    projectRoot: "/proj",
    status: "completed",
    createdAt: Date.now(),
    events: [
      ev("run.started", { mode: "code", instruction: "fix tests" }),
      ev("run.execution", { executionTargetRequested: "auto", executionTargetActual: "local_host" }),
      ev("tool.started", { tool: "edit_file" }),
      ev("file.edit", { path: "calc.ts" }),
      ev("tool.completed", { tool: "edit_file" }),
      ev("tool.started", { tool: "run_tests" }),
      ev("tool.completed", { tool: "run_tests" }),
      ev("artifact.created", { artifactId: "art_1", name: "out.png" }),
    ],
    nextSequence: 8,
    subscribers: new Set(),
    usage: { promptTokens: 100, completionTokens: 50, turns: 1 },
    ...over,
  };
}

test("sanitize redacts tokens and secret keys", () => {
  assert.match(sanitizeLearningText("token=sk-abcdefghi123"), /\[redacted\]/);
  assert.doesNotMatch(sanitizeLearningText("token=sk-abcdefghi123"), /sk-abcdefghi123/);
  const rec = sanitizeRecord({ apiKey: "secret-value", note: "ok", nested: { password: "p" } });
  assert.equal(rec.apiKey, "[redacted]");
  assert.equal(rec.nested.password, "[redacted]");
  assert.equal(rec.note, "ok");
});

test("evaluateRun marks training eligibility only for clean successes", () => {
  const ok = evaluateRun({ result: "success", testsRan: true, testsPassed: true, visual: true, artifacts: 1, failures: 0, corrections: 0 });
  assert.equal(ok.eligibleForTraining, true);
  assert.ok(ok.score >= 80);
  const bad = evaluateRun({ result: "failed", testsRan: true, testsPassed: false, visual: false, artifacts: 0, failures: 2, corrections: 1 });
  assert.equal(bad.eligibleForTraining, false);
  assert.ok(bad.reasons.includes("tests failed"));
  assert.ok(bad.reasons.includes("user rejection"));
});

test("ExperienceStore captures a run and isolates tenants", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-learn-"));
  const a = new LocalStore("tenant-a", dir);
  const b = new LocalStore("tenant-b", dir);
  const storeA = new ExperienceStore("tenant-a", a);
  const storeB = new ExperienceStore("tenant-b", b);
  storeA.captureFromRun(run());
  assert.equal(storeA.list("experience").length, 1);
  assert.equal(storeB.list("experience").length, 0);
  assert.equal(storeA.list("experience")[0].tenantId, "tenant-a");
  assert.equal(storeA.list("experience")[0].executionTarget, undefined);
  const exp = storeA.list("experience")[0];
  assert.equal(exp.result, "success");
  assert.equal(exp.tests.passed, true);
  assert.equal(exp.verification.artifacts, 1);
  assert.throws(() => bindTenantResource("tenant-a", "tenant-b"), /Tenant isolation/);
});

test("skill candidates need two successful runs and stay unvalidated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-skill-"));
  const store = new LocalStore("tenant-a", dir);
  const expStore = new ExperienceStore("tenant-a", store);
  const e1 = expStore.captureFromRun(run({ id: "run_1" }));
  const e2 = expStore.captureFromRun(run({ id: "run_2" }));
  const skills = skillCandidatesFromExperiences([e1, e2]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].validated, false);
  assert.match(skills[0].validation, /do not auto-promote/);
  persistSkillCandidates(store, [e1, e2]);
  persistSkillCandidates(store, [e1, e2]);
  assert.equal(store.listLearningRecords("skill").length, 1);
});

test("training dataset filters rejected and failed runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-ds-"));
  const store = new LocalStore("tenant-a", dir);
  const expStore = new ExperienceStore("tenant-a", store);
  const good = expStore.captureFromRun(run());
  const failed = expStore.captureFromRun(run({
    id: "run_bad",
    status: "error",
    events: [ev("tool.failed", { tool: "run_tests", error: "boom" })],
  }));
  assert.equal(trainingCandidates([good, failed]).length, 1);
  const ds = persistDataset(store, [good, failed]);
  assert.ok(ds);
  assert.equal(ds.status, "candidate");
  assert.equal(ds.id, "ds_current");
});

test("ModelRegistry refuses production auto-promote", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-mdl-"));
  const store = new LocalStore("tenant-a", dir);
  const reg = new ModelRegistry(store);
  const row = reg.register({ version: "orvyn-ft-1", datasetVersion: "ds_current" });
  assert.equal(row.status, "candidate");
  assert.throws(() => reg.setStatus(row.id, "production"), /Refusing to auto-promote/);
  const staged = reg.setStatus(row.id, "staging");
  assert.equal(staged?.status, "staging");
});

test("failure clustering buckets known categories", () => {
  const clusters = clusterFailures(["artifact persist failed", "mcp gateway timeout", "visual screenshot miss"]);
  assert.deepEqual(
    clusters.map((c) => c.category),
    ["artifact generation", "MCP timeout", "visual regression"]
  );
});

test("run replay records requested vs actual target and artifacts", () => {
  const replay = buildRunReplay(run());
  assert.equal(replay.requestedExecutionTarget, "auto");
  assert.equal(replay.actualExecutionTarget, "local_host");
  assert.equal(replay.filesChanged.includes("calc.ts"), true);
  assert.equal(replay.artifacts[0].artifactId, "art_1");
  assert.equal(replay.tests.passed, true);
});
