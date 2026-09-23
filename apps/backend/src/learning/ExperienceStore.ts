import { randomUUID } from "crypto";
import type { LocalStore } from "../persistence/LocalStore";
import type { Run } from "../agent/events";
import { sanitizeRecord, sanitizeLearningText } from "./sanitize";
import { evaluateRun, type RunEvaluation } from "./RunEvaluator";

export interface Experience {
  id: string;
  tenantId: string;
  runId: string;
  taskType: string;
  executionTarget?: string;
  toolsUsed: string[];
  edits: number;
  tests: { ran: boolean; passed?: boolean };
  verification: { visual?: boolean; artifacts?: number };
  failures: string[];
  userCorrections: number;
  result: "success" | "failed" | "cancelled";
  createdAt: number;
  evaluation: RunEvaluation;
}

export class ExperienceStore {
  constructor(private tenantId: string, private store: LocalStore) {}

  captureFromRun(run: Run): Experience {
    const tools = new Set<string>();
    let edits = 0;
    let testsRan = false;
    let testsPassed: boolean | undefined;
    let visual = false;
    let artifacts = 0;
    let corrections = 0;
    const failures: string[] = [];
    for (const e of run.events) {
      const tool = String(e.data.tool ?? e.data.name ?? "");
      if (e.type === "tool.started" && tool) tools.add(tool);
      if (e.type === "file.edit") edits++;
      if (e.type === "artifact.created" && (e.data.artifactId || e.data.id)) artifacts++;
      if (e.type === "tool.completed" && /test/i.test(tool)) {
        testsRan = true;
        testsPassed = true;
      }
      if (e.type === "tool.failed") {
        failures.push(sanitizeLearningText(`${tool}:${e.data.error ?? "failed"}`));
        if (/test/i.test(tool)) {
          testsRan = true;
          testsPassed = false;
        }
      }
      if (e.type === "desktop.verification.passed" || e.type === "browser.completed") visual = true;
      if (e.type === "approval.resolved" && e.data.approved === false) corrections++;
    }
    const result = run.status === "completed" ? "success" : run.status === "cancelled" ? "cancelled" : "failed";
    const evaluation = evaluateRun({
      result,
      testsRan,
      testsPassed,
      visual,
      artifacts,
      failures: failures.length,
      corrections,
    });
    const exp: Experience = sanitizeRecord({
      id: `exp_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      tenantId: this.tenantId,
      runId: run.id,
      taskType: String(run.events.find((e) => e.type === "run.started")?.data.mode ?? "agent"),
      executionTarget: run.execution?.executionLocation,
      toolsUsed: [...tools],
      edits,
      tests: { ran: testsRan, passed: testsPassed },
      verification: { visual, artifacts },
      failures,
      userCorrections: corrections,
      result,
      createdAt: Date.now(),
      evaluation,
    });
    this.store.saveLearningRecord({ id: exp.id, kind: "experience", payload: exp });
    return exp;
  }

  list(kind = "experience", limit = 80): Experience[] {
    return this.store.listLearningRecords(kind, limit).map((r) => r.payload as Experience);
  }

  overview() {
    const experiences = this.list("experience", 200);
    const skills = this.store.listLearningRecords("skill", 80);
    const datasets = this.store.listLearningRecords("dataset", 40);
    const models = this.store.listLearningRecords("model", 20);
    const failures = experiences.flatMap((e) => e.failures);
    const clusters = clusterFailures(failures);
    return {
      experiencesCollected: experiences.length,
      successfulRuns: experiences.filter((e) => e.result === "success").length,
      trainingCandidates: datasets.length,
      validatedSkills: skills.filter((s) => (s.payload as { validated?: boolean }).validated).length,
      skillCandidates: skills.length,
      failureClusters: clusters,
      currentCandidateModel: models.find((m) => (m.payload as { status?: string }).status === "candidate")?.payload ?? null,
    };
  }
}

export function clusterFailures(failures: string[]): { category: string; count: number }[] {
  const buckets = new Map<string, number>();
  for (const f of failures) {
    const t = f.toLowerCase();
    const category = /artifact|persist|png|zero-byte/.test(t)
      ? "artifact generation"
      : /mcp|timeout|gateway/.test(t)
        ? "MCP timeout"
        : /electron|dist:win|packag/.test(t)
          ? "Electron packaging"
          : /visual|screenshot|browser|desktop/.test(t)
            ? "visual regression"
            : /worker|ovh|container/.test(t)
              ? "worker crash"
              : /approval/.test(t)
                ? "tool approval loop"
                : "other";
    buckets.set(category, (buckets.get(category) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}
