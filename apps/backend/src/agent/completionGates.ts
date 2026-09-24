import { classifyExecutionHints } from "../execution/classifyExecution";
import { asksToReadFileBack, looksLikeFileDeliverableRequest, looksLikeWorkspaceFileTask, type GroundedArtifact } from "../artifacts/claimValidator";

export type CompletionGateId = "artifact" | "code" | "visual";

export interface CompletionGateInput {
  instruction: string;
  artifacts: GroundedArtifact[];
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  /** When set, only that task's evidence gate applies. */
  category?: string;
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

function toolName(event: CompletionGateInput["events"][number]): string {
  return String(event.data?.tool ?? event.data?.name ?? "");
}

function workspaceWriteSucceeded(events: CompletionGateInput["events"]): boolean {
  return events.some((event) => {
    if (event.type === "file.created" || event.type === "file.edit") return true;
    return event.type === "tool.completed" && /^(write_file|edit_file)$/i.test(toolName(event));
  });
}

function workspaceReadSucceeded(events: CompletionGateInput["events"]): boolean {
  return events.some((event) => event.type === "file.read" || (event.type === "tool.completed" && /^read_file$/i.test(toolName(event))));
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

  const workspaceFile = looksLikeWorkspaceFileTask(input.instruction);
  if (workspaceFile) {
    const wrote = workspaceWriteSucceeded(input.events);
    const needsRead = asksToReadFileBack(input.instruction);
    const read = workspaceReadSucceeded(input.events);
    if (!wrote || (needsRead && !read)) {
      failedGate = "code";
      reasons.push(!wrote
        ? "The workspace file was not written."
        : "The file was not read back.");
    }
  }

  if (!failedGate && (looksLikeFileDeliverableRequest(input.instruction) || hints.isArtifact)) {
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

  const website = /\b(website|web\s*site|landing\s*page|homepage|home\s*page|joomla)\b/i.test(input.instruction)
    && /\b(build|create|make|design|generate)\b/i.test(input.instruction);
  if (!failedGate && website) {
    const wrotePage = input.events.some((e) => {
      if (e.type !== "file.created" && e.type !== "file.edit") return false;
      return /\.(html|php|css|js|xml)$/i.test(String(e.data?.path ?? ""));
    });
    if (!wrotePage) {
      failedGate = "code";
      reasons.push("The site files were not written.");
    }
  }

  if (!failedGate && input.category === "server" && !website) {
    const remote = input.events.some((e) => e.type === "tool.completed" && /^(ssh_exec|remote_exec)$/i.test(toolName(e)));
    if (!remote) {
      failedGate = "code";
      reasons.push("No remote command result from the resolved server.");
    }
  }

  const visualTask =
    (!input.category && hints.isVisual && !hints.isArtifact) ||
    ((input.category === "browser" || input.category === "desktop") &&
      /\b(verify|screenshot|homepage|dialog)\b/i.test(input.instruction));
  if (!failedGate && visualTask) {
    if (!visualVerified(input.events)) {
      failedGate = "visual";
      reasons.push("UI work has no screenshot or desktop verification.");
    }
  }

  if (!failedGate) {
    return { ok: true, reasons: [], retryPrompt: "", failMessage: "" };
  }

  const fileIncomplete = workspaceFile && (
    !workspaceWriteSucceeded(input.events) ||
    (asksToReadFileBack(input.instruction) && !workspaceReadSucceeded(input.events))
  );
  const retry =
    failedGate === "artifact"
      ? "COMPLETION GATE — ARTIFACT: Do not say the file exists. Call generate_image, create_document, or artifact_create and wait for a tool result that includes artifactId. Then tell the user the file is in Files → Generated (virtual file storage). Never cite a sandbox path."
      : fileIncomplete
        ? workspaceWriteSucceeded(input.events)
          ? "COMPLETION GATE — FILE: write_file succeeded. Call read_file on that same path and report only the contents from the tool result. Do not finish before the read."
          : "COMPLETION GATE — FILE: This is a workspace file. Call write_file with the requested path and exact contents, then read_file and report that result. Do not use generate_image or create_document for a plain text file."
        : website && failedGate === "code"
          ? "COMPLETION GATE — WEBSITE: You build this site. Call write_file for every page, style, and template file. Do not describe the site instead of writing it. Do not stop until the files exist in the workspace."
        : input.category === "server"
          ? "COMPLETION GATE — SERVER: Call ssh_exec or remote_exec on the resolved server and report that command's output. Do not claim the server was checked."
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
