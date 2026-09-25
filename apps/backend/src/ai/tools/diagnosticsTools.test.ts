import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunTestsTool } from "./diagnosticsTools";

// node --test marks child processes as part of this run; the fixture project
// must run its own suite, as it does for a real user.
delete process.env.NODE_TEST_CONTEXT;

function project(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-run-tests-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: "node --test" } }));
  writeFileSync(join(dir, "a.test.js"), `const test = require("node:test"); const assert = require("node:assert"); test("t", () => { ${body} });\n`);
  return dir;
}

test("run_tests reports a failing suite as a failed tool call, with the output", async () => {
  const res = await makeRunTestsTool(project("assert.strictEqual(1, 2);")).execute({});
  assert.equal(res.ok, false);
  assert.match(String(res.error), /Tests failed \(exit [1-9]/);
  assert.match(String(res.error), /\$ npm test/);
});

test("run_tests reports a passing suite as success", async () => {
  const res = await makeRunTestsTool(project("assert.strictEqual(1, 1);")).execute({});
  assert.equal(res.ok, true, String(res.error ?? ""));
  assert.match(String(res.output), /exit 0/);
});
