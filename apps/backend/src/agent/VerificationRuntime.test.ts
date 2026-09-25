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

  const silent = { ...(provider as object), generate: async () => ({ content: "All good!", finishReason: "stop" }) } as never;
  const r2 = await new VerificationRuntime({ tools, provider: silent, toolDefinitions: [] }).verify(ev);
  assert.equal(r2.verdict, "FAIL");
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
