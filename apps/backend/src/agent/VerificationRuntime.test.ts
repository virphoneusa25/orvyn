import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIResponse } from "@orvyn/ai-core";
import {
  collectVerificationEvidence,
  cssBalanceError,
  localReferences,
  parseVerdict,
  resolveRef,
  scriptSyntaxError,
  VerificationRuntime,
  type VerificationEvidence,
} from "./VerificationRuntime";

function filesTools(files: Record<string, string>, log: string[] = []) {
  return {
    log,
    execute: async (tool: string, args: Record<string, unknown>) => {
      log.push(tool);
      if (tool === "read_file") {
        const p = String(args.path);
        return p in files ? { ok: true, output: files[p] } : { ok: false, error: `ENOENT: no such file ${p}` };
      }
      if (tool === "write_file") { files[String(args.path)] = String(args.content); return { ok: true, output: "written" }; }
      return { ok: true, output: "" };
    },
  };
}

function evidence(over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    goal: "Build a landing page",
    changedFiles: [{ path: "index.html", operation: "write" }, { path: "app.js", operation: "write" }],
    toolEvidence: [],
    testBuildEvidence: [],
    browserEvidence: [],
    previewUrls: [],
    lastChangeSequence: 10,
    website: true,
    ...over,
  };
}

const BROKEN = {
  "index.html": '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hi</h1><script src="app.js"></script><a href="https://x.com">x</a><a href="#top">top</a></body></html>',
  "app.js": "document.querySelector('h1').textContent = 'Hello';\nfunction broken( {\n",
};

test("helpers: references, paths, syntax", () => {
  assert.deepEqual(localReferences(BROKEN["index.html"]).sort(), ["app.js", "style.css"]);
  assert.equal(resolveRef("site/index.html", "../assets/a.css"), "assets/a.css");
  assert.equal(resolveRef("site/index.html", "/root.css"), "root.css");
  assert.match(String(scriptSyntaxError(BROKEN["app.js"])), /Unexpected token|expected/i);
  assert.equal(scriptSyntaxError("export const a = 1;"), null, "modules are not judged by the classic parser");
  assert.equal(cssBalanceError("a{color:red}"), null);
  assert.match(String(cssBalanceError("a{color:red")), /unclosed/);
  assert.equal(parseVerdict("VERDICT: partial\n- x"), "PARTIAL");
  assert.equal(parseVerdict("Looks fine"), null);
  assert.equal(parseVerdict("Checked.\n**VERDICT: PASS**"), "PASS");
});

test("a broken site FAILS with findings naming the missing stylesheet and the script error", async () => {
  const r = await new VerificationRuntime({ tools: filesTools({ ...BROKEN }) }).verify(evidence());
  assert.equal(r.verdict, "FAIL");
  const text = r.findings.map((f) => f.message).join("\n");
  assert.match(text, /style\.css does not exist/);
  assert.match(text, /app\.js does not parse/);
});

test("the fixed site with a clean browser check PASSES; without a browser check it is PARTIAL", async () => {
  const fixed = { ...BROKEN, "style.css": "h1{color:#222}", "app.js": "document.querySelector('h1').textContent = 'Hello';\n" };
  const clean = [{ tool: "browser_console_errors", sessionId: "bs_1", url: "https://x/", consoleErrors: 0, networkErrors: 0, sequence: 11 }];
  const pass = await new VerificationRuntime({ tools: filesTools({ ...fixed }) }).verify(evidence({ browserEvidence: clean }));
  assert.equal(pass.verdict, "PASS", JSON.stringify(pass.findings));
  const partial = await new VerificationRuntime({ tools: filesTools({ ...fixed }) }).verify(evidence());
  assert.equal(partial.verdict, "PARTIAL");
  const stale = await new VerificationRuntime({ tools: filesTools({ ...fixed }) }).verify(evidence({ browserEvidence: [{ ...clean[0]!, sequence: 5 }] }));
  assert.equal(stale.verdict, "PARTIAL", "a browser check from before the last change does not count");
  const dirty = await new VerificationRuntime({ tools: filesTools({ ...fixed }) }).verify(evidence({ browserEvidence: [{ ...clean[0]!, consoleErrors: 2 }] }));
  assert.equal(dirty.verdict, "FAIL");
});

test("a failing test run that was never fixed FAILS", async () => {
  const r = await new VerificationRuntime({ tools: filesTools({ "a.js": "1;" }) }).verify(
    evidence({ website: false, changedFiles: [{ path: "a.js", operation: "edit" }], testBuildEvidence: [{ command: "npm test", ok: false, exitCode: 1, sequence: 12 }] })
  );
  assert.equal(r.verdict, "FAIL");
  assert.match(r.findings[0]!.message, /npm test.*failed/);
});

test("the verifier model is read-only: a write is blocked, and no verdict means FAIL", async () => {
  const files: Record<string, string> = { "a.js": "1;" };
  const tools = filesTools(files);
  let n = 0;
  const provider = {
    config: { id: "v" },
    supportsTools: () => true,
    supportsVision: () => false,
    async generate(): Promise<AIResponse> {
      n++;
      if (n === 1) return { content: "", finishReason: "tool_call", toolCalls: [{ id: "w", name: "write_file", arguments: { path: "a.js", content: "hacked" } }] };
      if (n === 2) return { content: "", finishReason: "tool_call", toolCalls: [{ id: "r", name: "read_file", arguments: { path: "a.js" } }] };
      return { content: "VERDICT: PASS\n- a.js is fine", finishReason: "stop" };
    },
  } as never;
  const ev = evidence({ website: false, changedFiles: [{ path: "a.js", operation: "write" }] });
  const r = await new VerificationRuntime({ tools, provider, toolDefinitions: [] }).verify(ev);
  assert.equal(files["a.js"], "1;", "nothing was written");
  assert.ok(r.toolCalls.some((c) => c.tool === "write_file" && c.blocked));
  assert.equal(r.verdict, "PASS");

  // A verifier that never gives a verdict certifies nothing (PARTIAL), and that
  // is not handed to the working agent as something to fix.
  let asked = 0;
  const silent = { ...(provider as object), generate: async () => { asked++; return { content: "All good!", finishReason: "stop" }; } } as never;
  const r2 = await new VerificationRuntime({ tools, provider: silent, toolDefinitions: [] }).verify(ev);
  assert.equal(r2.verdict, "PARTIAL");
  assert.equal(asked, 2, "asked once more for the verdict line");
  const { actionableFindings } = await import("./VerificationRuntime");
  assert.equal(actionableFindings(r2).length, 0);
  // A verdict wrapped in markdown after a sentence still counts.
  const chatty = { ...(provider as object), generate: async () => ({ content: "I checked everything.\n\n## **Verdict: FAIL**\n- a.js is empty", finishReason: "stop" }) } as never;
  const r3 = await new VerificationRuntime({ tools, provider: chatty, toolDefinitions: [] }).verify(ev);
  assert.equal(r3.verdict, "FAIL");
});

test("TEST F and G — unknown git_status cannot be a global pass", async () => {
  const fixed = {
    "index.html": "<html><body><h1>Hi</h1></body></html>",
    "style.css": "h1{color:#222}",
    "app.js": "document.querySelector('h1').textContent = 'Hello';\n",
  };
  const tools = {
    execute: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "git_status") return { ok: false, error: "Unknown tool: git_status" };
      if (tool === "read_file") {
        const p = String(args.path);
        return p in fixed ? { ok: true, output: fixed[p as keyof typeof fixed] } : { ok: false, error: "missing" };
      }
      return { ok: true, output: "" };
    },
  };
  const provider = {
    supportsTools: () => true,
    supportsVision: () => false,
    async generate(): Promise<AIResponse> {
      return { content: "VERDICT: PASS\n- looks done", finishReason: "stop" };
    },
  } as never;
  const clean = [{ tool: "browser_console_errors", sessionId: "bs_1", url: "https://x/", consoleErrors: 0, networkErrors: 0, sequence: 11 }];
  const r = await new VerificationRuntime({
    tools,
    provider,
    toolDefinitions: [{ name: "git_status", description: "git", parameters: { type: "object", properties: {} } }],
  }).verify(evidence({ browserEvidence: clean, changedFiles: [{ path: "index.html", operation: "write" }] }));
  assert.equal(r.toolCalls.some((c) => c.tool === "git_status"), true);
  assert.equal(r.toolCalls.find((c) => c.tool === "git_status")?.ok, false);
  assert.notEqual(r.verdict, "PASS");
  assert.equal(r.verdict, "PARTIAL");
  assert.match(r.findings.map((f) => f.message).join("\n"), /Git status unavailable/);
  assert.doesNotMatch(r.findings.map((f) => f.message).join("\n"), /Verified: independent check passed/);
});

test("evidence is collected from envelopes: changed files, tests, browser", () => {
  const env = (tool: string, status: string, structuredData: Record<string, unknown>, evidence: unknown[] = []) => ({ tool, envelope: { toolName: tool, status, userSummary: tool, structuredData, evidence } });
  const ev = collectVerificationEvidence("goal", [
    { type: "tool.completed", sequence: 1, data: env("write_file", "success", { path: "index.html" }, [{ type: "file", file: "index.html", operation: "write" }]) },
    { type: "tool.failed", sequence: 2, data: env("terminal", "error", { command: "npm test", exitCode: 1 }) },
    { type: "preview.available", sequence: 3, data: { url: "http://h/api/v1/sites/x/" } },
    { type: "tool.completed", sequence: 4, data: env("browser_console_errors", "success", { browserSessionId: "bs_1", url: "http://h/", consoleErrors: 1, networkErrors: 0 }) },
  ]);
  assert.deepEqual(ev.changedFiles, [{ path: "index.html", operation: "write" }]);
  assert.deepEqual(ev.testBuildEvidence.map((t) => [t.command, t.ok]), [["npm test", false]]);
  assert.equal(ev.browserEvidence[0]?.consoleErrors, 1);
  assert.deepEqual(ev.previewUrls, ["http://h/api/v1/sites/x/"]);
  assert.equal(ev.website, true);
  assert.equal(ev.lastChangeSequence, 1);
});

test("follow-up verification records only successful before and after edits", () => {
  const env = { toolName: "edit_file", status: "success", userSummary: "edited", structuredData: {}, evidence: [{ type: "file", file: "styles.css", operation: "edit" }] };
  const evidence = collectVerificationEvidence("Make the hero animation slower", [
    { type: "tool.input", sequence: 1, data: { callId: "edit-1", input: { path: "styles.css", old_string: "animation: drift 18s", new_string: "animation: drift 45s" } } },
    { type: "tool.completed", sequence: 2, data: { callId: "edit-1", tool: "edit_file", envelope: env } },
  ]);
  assert.deepEqual(evidence.editTransitions, [{ path: "styles.css", before: "animation: drift 18s", after: "animation: drift 45s" }]);
});

test("a check that does not apply to the project is not a failure (no tsconfig, no test script)", () => {
  const na = (tool: string, msg: string, sd: Record<string, unknown> = {}) => ({ tool, envelope: { toolName: tool, status: "error", userSummary: tool, modelPayload: msg, structuredData: sd, evidence: [] } });
  const ev = collectVerificationEvidence("Build a small landing page", [
    { type: "tool.failed", sequence: 1, data: na("run_typecheck", "Not applicable: no tsconfig.json at C:\\site, so this project has no TypeScript to check.") },
    { type: "tool.failed", sequence: 2, data: na("run_tests", "Not applicable: no test runner found") },
    { type: "tool.failed", sequence: 3, data: na("terminal", "'npm' is not recognized as an internal or external command", { command: "npm test", exitCode: 1 }) },
    { type: "tool.failed", sequence: 4, data: na("run_tests", "Tests failed (exit 1).", {}) },
  ]);
  assert.deepEqual(ev.testBuildEvidence.map((t) => [t.command, t.ok]), [["run_tests", false]]);
});

// ── Task-aware verification ──────────────────────────────────────────────────

test("a file-only CSS task does NOT require browser verification (no page changed)", async () => {
  // The exact production case: "Create demo-styles.css with a :root block"
  // classified as frontend intent, but only a css file was written. The
  // browser check must be skipped, not unverified — a correct file write
  // passes on existence + syntax alone.
  const ev = evidence({
    goal: "Create demo-styles.css containing a :root block with CSS custom properties",
    changedFiles: [{ path: "demo-styles.css", operation: "write" }],
    website: false,
  });
  assert.equal(ev.website, false, "no page changed → not a website-verification task");
  const runtime = new VerificationRuntime({ tools: filesTools({ "demo-styles.css": ":root { --bg: #050b14; }\n.hero { font-family: 'Segoe UI'; }" }) });
  const result = await runtime.verify(ev);
  const browser = result.checks.find((c) => c.name === "browser");
  assert.equal(browser?.status, "skip");
  assert.match(browser?.detail ?? "", /not required/i);
  assert.equal(result.verdict, "PASS", "a correct standalone css file verifies without a browser");
});

test("collectVerificationEvidence requires the browser for page changes and intent-scoped visual work", () => {
  const events = [
    { type: "tool.completed", sequence: 1, data: { callId: "c1", tool: "write_file", envelope: { toolName: "write_file", status: "success", userSummary: "w", evidence: [{ type: "file", file: "demo-styles.css", operation: "write" }] } } },
  ];
  // No frontend intent → a standalone css file is file-deliverable.
  const cssOnly = collectVerificationEvidence("create a css file", events as never);
  assert.equal(cssOnly.website, false, "css-only change without frontend intent → browser not required");
  // Frontend intent + a frontend file changed IS a visual change: "make the
  // navbar responsive" editing only styles.css must see a browser.
  const visual = collectVerificationEvidence("make the navbar responsive", events as never, { website: true });
  assert.equal(visual.website, true, "frontend intent + css change → browser verification required");
  const pageEvents = [
    { type: "tool.completed", sequence: 1, data: { callId: "c1", tool: "write_file", envelope: { toolName: "write_file", status: "success", userSummary: "w", evidence: [{ type: "file", file: "index.html", operation: "write" }] } } },
  ];
  const withPage = collectVerificationEvidence("add a hero", pageEvents as never, { website: true });
  assert.equal(withPage.website, true, "an html page change → browser verification required");
});

test("a page change without browser evidence is still PARTIAL (over-verification guard only relaxed for file-only tasks)", async () => {
  const ev = evidence({ goal: "Update the site hero", changedFiles: [{ path: "index.html", operation: "edit" }], website: true });
  const runtime = new VerificationRuntime({ tools: filesTools({ "index.html": "<html><body><h1>Hi</h1><main>x y z more text to render here ok</main></body></html>" }) });
  const result = await runtime.verify(ev);
  assert.equal(result.verdict, "PARTIAL", "site work without browser evidence stays PARTIAL");
});
