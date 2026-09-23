import { classifyExecutionHints } from "../execution/classifyExecution";
import { looksLikeFileDeliverableRequest, type GroundedArtifact } from "../artifacts/claimValidator";

export type CompletionGateId = "artifact" | "code" | "visual";

export interface CompletionGateInput {
  instruction: string;
  artifacts: GroundedArtifact[];
  events: Array<{ type: string; data?: Record<string, unknown> }>;
}

export interface CompletionGateResult {
  ok: boolean;
  failedGate?: CompletionGateId;
  reasons: string[];
  retryPrompt: string;
  failMessage: string;
}

function testsRan(events: CompletionGateInput["events"]): { ran: boolean; passed: boolean } {
  let ran = false;
  let failed = false;
  for (const e of events) {
    const tool = String(e.data?.tool ?? e.data?.name ?? "");
    if (e.type === "test.completed") {
      ran = true;
      if (e.data?.ok === false || e.data?.passed === false) failed = true;
    }
    if (e.type === "tool.completed" && /test|typecheck|lint/i.test(tool)) ran = true;
    if (e.type === "tool.failed" && /test|typecheck|lint/i.test(tool)) {
      ran = true;
      failed = true;
    }
  }
  return { ran, passed: ran && !failed };
}

function visualVerified(events: CompletionGateInput["events"]): boolean {
  return events.some((e) =>
    e.type === "desktop.verification.passed" ||
    e.type === "browser.completed" ||
    (e.type === "desktop.screenshot" && e.data?.artifactId) ||
    (e.type === "tool.completed" && /screenshot|browser_screenshot|desktop_screenshot/i.test(String(e.data?.tool ?? "")))
  );
}

/**
 * Hard completion gates. A run that asked for a file / tests / visual proof
 * cannot settle as success without the matching evidence.
 */
export function evaluateCompletionGates(input: CompletionGateInput): CompletionGateResult {
  const hints = classifyExecutionHints(input.instruction);
  const reasons: string[] = [];
  let failedGate: CompletionGateId | undefined;

  if (looksLikeFileDeliverableRequest(input.instruction) || hints.isArtifact) {
    const ready = input.artifacts.filter((a) => a.artifactId && a.name);
    if (ready.length === 0) {
      failedGate = "artifact";
      reasons.push("No persisted artifactId — nothing is in Files → Generated.");
    }
  }

  if (!failedGate && hints.isLocalCoding && /\b(test|tests|typecheck|lint|verify)\b/i.test(input.instruction)) {
    const tests = testsRan(input.events);
    if (!tests.ran || !tests.passed) {
      failedGate = "code";
      reasons.push(tests.ran ? "Tests ran and failed." : "Code change was not verified with tests.");
    }
  }

  if (!failedGate && hints.isVisual && !hints.isArtifact) {
    if (!visualVerified(input.events)) {
      failedGate = "visual";
      reasons.push("UI work has no screenshot or desktop verification.");
    }
  }

  if (!failedGate) {
    return { ok: true, reasons: [], retryPrompt: "", failMessage: "" };
  }

  const retry =
    failedGate === "artifact"
      ? "COMPLETION GATE — ARTIFACT: Do not say the file exists. Call generate_image, create_document, or artifact_create and wait for a tool result that includes artifactId. Then tell the user the file is in Files → Generated (virtual file storage). Never cite a sandbox path."
      : failedGate === "code"
        ? "COMPLETION GATE — CODE: Run the tests (or typecheck) and only finish if they pass. Do not claim the fix is done without that result."
        : "COMPLETION GATE — VISUAL: Take a browser or desktop screenshot and verify the visible result before finishing.";

  return {
    ok: false,
    failedGate,
    reasons,
    retryPrompt: retry,
    failMessage: `The run is not complete: ${reasons.join(" ")}`,
  };
}
