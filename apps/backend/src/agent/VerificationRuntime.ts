// apps/backend/src/agent/VerificationRuntime.ts
//
// An independent check of implementation work before a run may complete.
//
// It receives the original goal, the changed files, the tool evidence (result
// envelopes), test/build evidence and browser evidence from the run. It may
// only READ and VERIFY: it runs read-only tools (files, search, git status,
// tests, the browser) and refuses anything that writes. It returns
//
//   PASS     the work does what the goal asked, with evidence
//   FAIL     something is broken or missing (findings say what)
//   PARTIAL  nothing is proven broken, but part of it could not be verified
//
// Two layers, both read-only:
//   1. deterministic checks that need no model: every changed file exists,
//      local references in HTML resolve, scripts parse, stylesheets balance,
//      the last test/build run passed, the browser saw no errors;
//   2. an adversarial verifier model with read-only tools, which must start
//      its answer with "VERDICT: PASS|FAIL|PARTIAL".
// The worst verdict wins. A verifier that cannot answer properly is a FAIL:
// nothing is certified by default.
//
// Pattern after CoWork-OS VerificationRuntime (MIT): read-only verifier,
// adversarial prompt, parsed verdict. Their runtime is not copied.

import * as vm from "vm";
import * as path from "path";
import type { AIMessage, AIModelProvider, ToolCall, ToolDefinition } from "@orvyn/ai-core";
import type { ToolResult } from "../ai/ToolTypes";

export type VerificationVerdict = "PASS" | "FAIL" | "PARTIAL";

export interface ChangedFile { path: string; operation: string }
export interface ToolEvidence { tool: string; status: string; summary: string; sequence: number; evidence: unknown[] }
export interface TestBuildEvidence { command: string; ok: boolean; exitCode: number | null; sequence: number }
export interface BrowserEvidence {
  tool: string;
  sessionId?: string;
  surface?: string;
  url?: string;
  consoleErrors?: number;
  networkErrors?: number;
  screenshot?: boolean;
  sequence: number;
}

export interface VerificationEvidence {
  goal: string;
  changedFiles: ChangedFile[];
  toolEvidence: ToolEvidence[];
  testBuildEvidence: TestBuildEvidence[];
  browserEvidence: BrowserEvidence[];
  /** Pages the run published (the verifier can open them in the browser). */
  previewUrls: string[];
  /** Sequence of the last file change; evidence older than this is stale. */
  lastChangeSequence: number;
  website: boolean;
}

export interface VerificationFinding {
  /**
   * blocker: the work is wrong. unverified: part of it could not be proven.
   * verifier-unavailable (check): the verifier itself failed; nothing for the
   * working agent to fix, so it is never sent back to it.
   */
  severity: "blocker" | "unverified";
  check: string;
  message: string;
  file?: string;
}

export interface VerificationCheck { name: string; status: "pass" | "fail" | "skip" | "unverified"; detail: string }

export interface VerificationResult {
  verdict: VerificationVerdict;
  findings: VerificationFinding[];
  checks: VerificationCheck[];
  /** The verifier model's own report (starts with VERDICT: …), if it ran. */
  report: string;
  modelVerdict?: VerificationVerdict;
  toolCalls: { tool: string; ok: boolean; blocked?: boolean }[];
}

/** What the verifier may call. Nothing here writes to the project. */
export const VERIFIER_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_code",
  "search_files",
  "search_codebase",
  "find_file",
  "git_status",
  "git_diff",
  "git_log",
  "run_tests",
  "run_typecheck",
  "run_linter",
  "get_diagnostics",
  "browser_open",
  "browser_navigate",
  "browser_set_viewport",
  "browser_scroll",
  "browser_screenshot",
  "browser_console_errors",
  "browser_evidence",
]);

export interface VerifierToolRunner {
  execute(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Wraps a tool runner so only VERIFIER_TOOLS get through. */
export function readOnly(runner: VerifierToolRunner): VerifierToolRunner {
  return {
    execute: async (tool, args) => {
      if (!VERIFIER_TOOLS.has(tool)) {
        return { ok: false, error: `Blocked: the verifier is read-only and may not call ${tool}.` };
      }
      return runner.execute(tool, args);
    },
  };
}

// ── Evidence from the run's events ───────────────────────────────────────────

interface EventLike { type: string; sequence?: number; data?: Record<string, any> }

const TEST_BUILD = /\b(test|vitest|jest|mocha|pytest|build|tsc|typecheck|lint|eslint)\b/i;
const WEBSITE_FILE = /\.(html?|css|js|mjs|jsx|tsx|vue|svelte|php)$/i;

/**
 * A check that could not apply to this project (no tsconfig, no test script,
 * a Unix command on Windows) is not a failure of the work. Counting it as one
 * made the agent add TypeScript, package.json and npm installs to a plain
 * HTML page just to turn the verifier green.
 */
export const NOT_APPLICABLE = /\bNot applicable\b|No tsconfig\.json found|No test runner found|no test specified|Missing script|No `lint` script|is not recognized as an internal or external command|: command not found|ENOENT[^\n]*package\.json/i;

export function collectVerificationEvidence(goal: string, events: EventLike[], opts: { website?: boolean } = {}): VerificationEvidence {
  const changed = new Map<string, ChangedFile>();
  const toolEvidence: ToolEvidence[] = [];
  const testBuild: TestBuildEvidence[] = [];
  const browser: BrowserEvidence[] = [];
  const previews = new Set<string>();
  let lastChange = 0;
  for (const e of events) {
    const seq = Number(e.sequence ?? 0);
    if (e.type === "preview.available" && typeof e.data?.url === "string") previews.add(e.data.url);
    if (e.type !== "tool.completed" && e.type !== "tool.failed") continue;
    const env = e.data?.envelope;
    const tool = String(e.data?.tool ?? env?.toolName ?? "");
    if (!env) continue;
    toolEvidence.push({ tool, status: env.status, summary: env.userSummary, sequence: seq, evidence: env.evidence ?? [] });
    if (env.status === "success") {
      for (const ev of env.evidence ?? []) {
        if (ev.type === "file" && ["write", "edit", "delete", "move"].includes(ev.operation)) {
          changed.set(ev.file, { path: ev.file, operation: ev.operation });
          lastChange = Math.max(lastChange, seq);
        }
      }
    }
    const command = String(env.structuredData?.command ?? "");
    if (env.status !== "success" && NOT_APPLICABLE.test(`${env.modelPayload ?? ""}\n${env.userSummary ?? ""}`)) continue;
    if ((tool === "terminal" || tool === "run_command") && TEST_BUILD.test(command) && !env.structuredData?.service) {
      testBuild.push({ command, ok: env.status === "success", exitCode: env.structuredData?.exitCode ?? null, sequence: seq });
    }
    if (tool === "run_tests" || tool === "run_typecheck" || tool === "run_linter") {
      testBuild.push({ command: tool, ok: env.status === "success", exitCode: env.structuredData?.exitCode ?? null, sequence: seq });
    }
    if (tool.startsWith("browser_") && env.status === "success") {
      const sd = env.structuredData ?? {};
      browser.push({
        tool,
        sessionId: sd.browserSessionId,
        surface: sd.surface,
        url: sd.url,
        consoleErrors: typeof sd.consoleErrors === "number" ? sd.consoleErrors : undefined,
        networkErrors: typeof sd.networkErrors === "number" ? sd.networkErrors : undefined,
        screenshot: Boolean(sd.screenshot),
        sequence: seq,
      });
    }
  }
  const changedFiles = [...changed.values()];
  return {
    goal,
    changedFiles,
    toolEvidence,
    testBuildEvidence: testBuild,
    browserEvidence: browser,
    previewUrls: [...previews],
    lastChangeSequence: lastChange,
    website: opts.website ?? changedFiles.some((f) => /\.html?$/i.test(f.path)),
  };
}

/** Implementation work: something was changed, or the task was to build/fix. */
export function isImplementationTask(evidence: VerificationEvidence): boolean {
  return evidence.changedFiles.length > 0;
}

// ── Deterministic, read-only checks ────────────────────────────────────────────

const SKIP_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{)/i;

/** Local files an HTML page needs: scripts, stylesheets, images, linked pages. */
export function localReferences(html: string): string[] {
  const refs = new Set<string>();
  const re = /<(script|link|img|source|a|iframe)\b[^>]*?\s(src|href)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[3]!.trim();
    if (!raw || SKIP_REF.test(raw)) continue;
    const clean = raw.split(/[?#]/)[0]!;
    if (clean) refs.add(clean);
  }
  return [...refs];
}

export function resolveRef(fromFile: string, ref: string): string {
  const base = ref.startsWith("/") ? "" : path.posix.dirname(fromFile.replace(/\\/g, "/"));
  return path.posix.normalize(path.posix.join(base === "." ? "" : base, ref.replace(/^\//, ""))).replace(/^\.\//, "");
}

/** Parses a classic script without running it. null: fine or not checkable. */
export function scriptSyntaxError(code: string): string | null {
  try {
    new vm.Script(code, { filename: "check.js" });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/import statement|export|import\.meta|await is only valid/i.test(msg)) return null; // an ES module: not checkable this way
    return msg;
  }
}

export function cssBalanceError(css: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, "");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return "a closing } has no matching {";
  }
  return depth > 0 ? `${depth} unclosed { block${depth === 1 ? "" : "s"}` : null;
}

async function deterministicChecks(evidence: VerificationEvidence, tools: VerifierToolRunner) {
  const findings: VerificationFinding[] = [];
  const checks: VerificationCheck[] = [];
  const read = async (p: string): Promise<string | null> => {
    const r = await tools.execute("read_file", { path: p });
    return r.ok ? String(r.output ?? "") : null;
  };

  // 1. Every changed file is really there.
  const present = new Map<string, string>();
  for (const f of evidence.changedFiles) {
    if (f.operation === "delete") continue;
    const text = await read(f.path);
    if (text === null) {
      findings.push({ severity: "blocker", check: "files", file: f.path, message: `${f.path} was reported as ${f.operation === "write" ? "written" : "edited"}, but it cannot be read.` });
    } else present.set(f.path, text);
  }
  checks.push({ name: "changed files exist", status: findings.some((x) => x.check === "files") ? "fail" : evidence.changedFiles.length ? "pass" : "skip", detail: `${present.size}/${evidence.changedFiles.filter((f) => f.operation !== "delete").length} readable` });

  // 2. Pages reference files that exist; scripts parse; styles balance.
  let refsChecked = 0;
  const sources = new Map(present);
  for (const [file, html] of present) {
    if (!/\.html?$/i.test(file)) continue;
    for (const ref of localReferences(html)) {
      const target = resolveRef(file, ref);
      refsChecked++;
      const text = sources.has(target) ? sources.get(target)! : await read(target);
      if (text === null) {
        findings.push({ severity: "blocker", check: "references", file, message: `${file} loads ${ref}, but ${target} does not exist.` });
      } else sources.set(target, text);
    }
  }
  checks.push({ name: "page references resolve", status: findings.some((x) => x.check === "references") ? "fail" : refsChecked ? "pass" : "skip", detail: `${refsChecked} local reference(s)` });

  let parsed = 0;
  for (const [file, text] of sources) {
    if (/\.(js|cjs)$/i.test(file)) {
      parsed++;
      const err = scriptSyntaxError(text);
      if (err) findings.push({ severity: "blocker", check: "syntax", file, message: `${file} does not parse: ${err}` });
    } else if (/\.css$/i.test(file)) {
      parsed++;
      const err = cssBalanceError(text);
      if (err) findings.push({ severity: "blocker", check: "syntax", file, message: `${file} is malformed: ${err}` });
    }
  }
  checks.push({ name: "scripts and styles parse", status: findings.some((x) => x.check === "syntax") ? "fail" : parsed ? "pass" : "skip", detail: `${parsed} file(s)` });

  // 3. The latest run of each test/build command passed.
  const latest = new Map<string, TestBuildEvidence>();
  for (const t of evidence.testBuildEvidence) latest.set(t.command, t);
  for (const t of latest.values()) {
    if (!t.ok) findings.push({ severity: "blocker", check: "tests", message: `\`${t.command}\` failed${t.exitCode !== null ? ` (exit ${t.exitCode})` : ""} and has not passed since.` });
    else if (t.sequence < evidence.lastChangeSequence) findings.push({ severity: "unverified", check: "tests", message: `\`${t.command}\` passed before the last change and was not run again.` });
  }
  checks.push({ name: "tests and builds", status: findings.some((x) => x.check === "tests" && x.severity === "blocker") ? "fail" : latest.size ? "pass" : "skip", detail: [...latest.values()].map((t) => `${t.command}: ${t.ok ? "passed" : "failed"}`).join(", ") || "none run" });

  // 4. The browser saw the current page without errors.
  const fresh = evidence.browserEvidence.filter((b) => b.sequence > evidence.lastChangeSequence);
  const lastState = [...fresh].reverse().find((b) => b.consoleErrors !== undefined || b.networkErrors !== undefined);
  if (lastState && ((lastState.consoleErrors ?? 0) > 0 || (lastState.networkErrors ?? 0) > 0)) {
    findings.push({ severity: "blocker", check: "browser", message: `The browser saw ${lastState.consoleErrors ?? 0} console error(s) and ${lastState.networkErrors ?? 0} failed request(s) on ${lastState.url || "the page"}.` });
  } else if (evidence.website && !fresh.length) {
    findings.push({ severity: "unverified", check: "browser", message: "The site was not opened in a browser after the last change." });
  }
  checks.push({
    name: "browser",
    status: findings.some((x) => x.check === "browser" && x.severity === "blocker") ? "fail" : fresh.length ? "pass" : evidence.website ? "unverified" : "skip",
    detail: fresh.length ? `${fresh.length} observation(s) after the last change${lastState ? ` · ${lastState.consoleErrors ?? 0} console / ${lastState.networkErrors ?? 0} network errors` : ""}` : "no browser evidence after the last change",
  });
  return { findings, checks };
}

// ── Verifier model (read-only tools) ───────────────────────────────────────────

/** Finds the verdict line; real models wrap it in markdown or put a sentence first. */
export function parseVerdict(text: string): VerificationVerdict | null {
  const m = /VERDICT\s*\**\s*[:\-–]\s*\**\s*(PASS|FAIL|PARTIAL)\b/i.exec(String(text ?? ""));
  return m ? (m[1]!.toUpperCase() as VerificationVerdict) : null;
}

export const VERIFIER_MARKER = "You are the ORVYN VERIFIER.";

function verifierPrompt(evidence: VerificationEvidence, deterministic: { findings: VerificationFinding[]; checks: VerificationCheck[] }): string {
  return [
    VERIFIER_MARKER,
    "Another agent says it finished the task below. Your job is to try to prove it is NOT finished.",
    "",
    "Rules:",
    "1. You may only READ and VERIFY: read files, search, run tests or builds, open the site in the browser, take screenshots. Never write, edit, delete, or run other commands.",
    "2. Be adversarial. Check the work against the goal, not against the agent's summary.",
    "3. Base every finding on a tool result you got here or on the evidence below.",
    "4. For a website, open the page in the browser and check console and network errors.",
    "5. Start your final answer with exactly one line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.",
    "6. Then list findings as short bullets (what is wrong, which file, what you saw).",
    "",
    `Goal: ${evidence.goal}`,
    "",
    "Changed files:",
    ...(evidence.changedFiles.length ? evidence.changedFiles.map((f) => `- ${f.path} (${f.operation})`) : ["- none"]),
    "",
    "Test and build runs:",
    ...(evidence.testBuildEvidence.length ? evidence.testBuildEvidence.map((t) => `- ${t.command}: ${t.ok ? "passed" : `failed${t.exitCode !== null ? ` (exit ${t.exitCode})` : ""}`}`) : ["- none"]),
    "",
    "Browser evidence:",
    ...(evidence.browserEvidence.length ? evidence.browserEvidence.slice(-6).map((b) => `- ${b.tool}: ${b.url ?? ""} session ${b.sessionId ?? "?"} console errors ${b.consoleErrors ?? "?"} network errors ${b.networkErrors ?? "?"}`) : ["- none"]),
    ...(evidence.previewUrls.length ? ["", `Published page: ${evidence.previewUrls[evidence.previewUrls.length - 1]}`] : []),
    "",
    "Automatic checks already run (read-only):",
    ...deterministic.checks.map((c) => `- ${c.name}: ${c.status} (${c.detail})`),
    ...deterministic.findings.map((f) => `- FINDING [${f.severity}] ${f.message}`),
  ].join("\n");
}

export interface VerificationRuntimeDeps {
  tools: VerifierToolRunner;
  provider?: AIModelProvider;
  toolDefinitions?: ToolDefinition[];
  maxTurns?: number;
  signal?: AbortSignal;
  /** Called for every verifier tool call (for the run's event stream). */
  onToolCall?: (call: { id: string; tool: string; args: Record<string, unknown> }, result: ToolResult) => void;
}

export class VerificationRuntime {
  private readonly tools: VerifierToolRunner;

  constructor(private readonly deps: VerificationRuntimeDeps) {
    this.tools = readOnly(deps.tools);
  }

  async verify(evidence: VerificationEvidence): Promise<VerificationResult> {
    const toolCalls: VerificationResult["toolCalls"] = [];
    const counted: VerifierToolRunner = {
      execute: async (tool, args) => {
        const r = await this.tools.execute(tool, args);
        toolCalls.push({ tool, ok: r.ok, blocked: !r.ok && /^Blocked: the verifier is read-only/.test(String(r.error)) || undefined });
        return r;
      },
    };
    const det = await deterministicChecks(evidence, counted);

    let report = "";
    let modelVerdict: VerificationVerdict | undefined;
    const provider = this.deps.provider;
    if (provider && provider.supportsTools()) {
      const out = await this.runVerifierModel(provider, evidence, det, counted);
      report = out.report;
      modelVerdict = out.verdict;
      // Browser evidence the verifier itself gathered counts for the browser check.
      if (out.browserObserved && det.findings.some((f) => f.check === "browser" && f.severity === "unverified")) {
        det.findings = det.findings.filter((f) => !(f.check === "browser" && f.severity === "unverified"));
        if (out.browserErrors > 0) det.findings.push({ severity: "blocker", check: "browser", message: `The verifier's browser saw ${out.browserErrors} error(s) on the page.` });
        const c = det.checks.find((x) => x.name === "browser");
        if (c) { c.status = out.browserErrors > 0 ? "fail" : "pass"; c.detail = `opened by the verifier · ${out.browserErrors} error(s)`; }
      }
    }

    const blockers = det.findings.filter((f) => f.severity === "blocker");
    const unverified = det.findings.filter((f) => f.severity === "unverified");
    let verdict: VerificationVerdict =
      blockers.length || modelVerdict === "FAIL" ? "FAIL" : unverified.length || modelVerdict === "PARTIAL" ? "PARTIAL" : "PASS";
    // A verifier that could not give a verdict certifies nothing, but it is not
    // a defect in the work either: the automatic checks stand, capped at PARTIAL.
    if (provider?.supportsTools() && modelVerdict === undefined && verdict === "PASS") verdict = "PARTIAL";
    const modelFindings = report
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((message): VerificationFinding => ({ severity: modelVerdict === "PARTIAL" ? "unverified" : "blocker", check: "verifier", message }));
    const findings = [...det.findings, ...(modelVerdict && modelVerdict !== "PASS" ? modelFindings : [])];
    if (provider?.supportsTools() && modelVerdict === undefined) {
      findings.push({ severity: "unverified", check: "verifier-unavailable", message: "The verifier model did not return a verdict; only the automatic checks were applied." });
    }
    return { verdict, findings, checks: det.checks, report, modelVerdict, toolCalls };
  }

  private async runVerifierModel(
    provider: AIModelProvider,
    evidence: VerificationEvidence,
    det: { findings: VerificationFinding[]; checks: VerificationCheck[] },
    tools: VerifierToolRunner
  ): Promise<{ report: string; verdict?: VerificationVerdict; browserObserved: boolean; browserErrors: number }> {
    const defs = (this.deps.toolDefinitions ?? []).filter((d) => VERIFIER_TOOLS.has(d.name));
    const messages: AIMessage[] = [
      { role: "system", content: verifierPrompt(evidence, det) },
      { role: "user", content: "Verify the work now. Use read-only tools, then give your verdict." },
    ];
    let browserObserved = false;
    let browserErrors = 0;
    const maxTurns = this.deps.maxTurns ?? 8;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.deps.signal?.aborted) break;
      const res = await provider.generate({ messages, tools: defs, signal: this.deps.signal } as never);
      const calls: ToolCall[] = res.toolCalls ?? [];
      if (!calls.length) {
        const report = String(res.content ?? "").trim();
        const verdict = parseVerdict(report);
        if (verdict) return { report, verdict, browserObserved, browserErrors };
        messages.push({ role: "assistant", content: report });
        break; // answered without a verdict line: ask for it once below
      }
      messages.push({ role: "assistant", content: res.content ?? "", toolCalls: calls, ...(res.reasoningContent ? { reasoningContent: res.reasoningContent } : {}) });
      for (const call of calls) {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const result = await tools.execute(call.name, args);
        this.deps.onToolCall?.({ id: call.id, tool: call.name, args }, result);
        if (call.name.startsWith("browser_") && result.ok) {
          browserObserved = true;
          const s = result.meta?.browserSession as { consoleErrors?: number; networkErrors?: number } | undefined;
          if (s && (call.name === "browser_console_errors" || call.name === "browser_evidence")) browserErrors = (s.consoleErrors ?? 0) + (s.networkErrors ?? 0);
        }
        const text = result.ok ? String(result.output ?? "") : `FAILED: ${result.error ?? "error"}`;
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: text.slice(0, 12_000) });
      }
    }
    // Out of turns (or the model kept calling tools): ask once for the verdict, no tools.
    try {
      messages.push({ role: "user", content: "Stop using tools. Give your verdict now. First line exactly: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL. Then the findings as bullets." });
      const res = await provider.generate({ messages, signal: this.deps.signal } as never);
      const report = String(res.content ?? "").trim();
      return { report, verdict: parseVerdict(report) ?? undefined, browserObserved, browserErrors };
    } catch {
      return { report: "", verdict: undefined, browserObserved, browserErrors };
    }
  }
}

/** Findings the working agent can act on (not problems of the verifier itself). */
export function actionableFindings(result: VerificationResult): VerificationFinding[] {
  return result.findings.filter((f) => f.check !== "verifier-unavailable");
}

/** The message the working agent gets when verification does not pass. */
export function findingsPrompt(result: VerificationResult, attempt: number): string {
  const lines = actionableFindings(result).map((f) => `- ${f.message}`);
  return [
    `VERIFICATION ${result.verdict} (independent check ${attempt}). The task is NOT complete yet.`,
    "An independent read-only verifier checked your work and found:",
    ...lines,
    "",
    "Fix every finding with the tools, check the result yourself, then give your final answer. Do not claim it is done until these are resolved.",
    "Fix the work the user asked for. Do not add new tooling (TypeScript, a tsconfig.json, a package.json, test frameworks, npm installs) to make a check pass unless the user asked for it.",
  ].join("\n");
}
