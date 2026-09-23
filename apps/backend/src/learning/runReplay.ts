import { estimateRunCost } from "../billing/BillingProvider";
import type { Run } from "../agent/events";

export interface RunReplay {
  runId: string;
  status: string;
  projectRoot: string;
  requestedExecutionTarget?: string;
  actualExecutionTarget?: string;
  fallbackReason?: string;
  toolSequence: { tool: string; ok?: boolean }[];
  filesChanged: string[];
  tests: { ran: boolean; passed?: boolean };
  verification: { visual?: boolean; desktop?: string };
  artifacts: { artifactId: string; name?: string }[];
  cost: { estimatedCost: number; executionCost: number; promptTokens: number; completionTokens: number };
}

export function buildRunReplay(run: Run): RunReplay {
  const exec = [...run.events].reverse().find((e) => e.type === "run.execution");
  const tools: { tool: string; ok?: boolean }[] = [];
  const files: string[] = [];
  const artifacts: { artifactId: string; name?: string }[] = [];
  let testsRan = false;
  let testsPassed: boolean | undefined;
  let visual = false;
  let desktop: string | undefined;
  for (const e of run.events) {
    const tool = String(e.data.tool ?? e.data.name ?? "");
    if (e.type === "tool.started" && tool) tools.push({ tool });
    if (e.type === "tool.completed" && tool) {
      const last = [...tools].reverse().find((t) => t.tool === tool && t.ok === undefined);
      if (last) last.ok = true;
      if (/test/i.test(tool)) {
        testsRan = true;
        testsPassed = true;
      }
    }
    if (e.type === "tool.failed" && tool) {
      const last = [...tools].reverse().find((t) => t.tool === tool && t.ok === undefined);
      if (last) last.ok = false;
      if (/test/i.test(tool)) {
        testsRan = true;
        testsPassed = false;
      }
    }
    if (e.type === "file.edit" && e.data.path) files.push(String(e.data.path));
    if (e.type === "artifact.created" && (e.data.artifactId || e.data.id)) {
      artifacts.push({ artifactId: String(e.data.artifactId ?? e.data.id), name: e.data.name ? String(e.data.name) : undefined });
    }
    if (e.type === "desktop.verification.started") desktop = "started";
    if (e.type === "desktop.verification.failed") {
      desktop = "failed";
      visual = false;
    }
    if (e.type === "desktop.verification.passed" || e.type === "browser.completed") {
      desktop = "passed";
      visual = true;
    }
    if (e.type === "preview.available") visual = true;
  }
  const cost = estimateRunCost({
    promptTokens: run.usage.promptTokens,
    completionTokens: run.usage.completionTokens,
  });
  return {
    runId: run.id,
    status: run.status,
    projectRoot: run.projectRoot,
    requestedExecutionTarget: exec?.data.executionTargetRequested ? String(exec.data.executionTargetRequested) : undefined,
    actualExecutionTarget: exec?.data.executionTargetActual ? String(exec.data.executionTargetActual) : run.execution?.executionLocation,
    fallbackReason: exec?.data.fallbackReason ? String(exec.data.fallbackReason) : undefined,
    toolSequence: tools,
    filesChanged: [...new Set(files)],
    tests: { ran: testsRan, passed: testsPassed },
    verification: { visual, desktop },
    artifacts,
    cost: {
      ...cost,
      promptTokens: run.usage.promptTokens,
      completionTokens: run.usage.completionTokens,
    },
  };
}
