import { test } from "node:test";
import assert from "node:assert/strict";
import { environmentLabel, resolveWorkbenchEnvironment, terminalTitle } from "./workbenchEnvironment.ts";

test("Workbench environment follows the current execution target", () => {
  assert.equal(resolveWorkbenchEnvironment({ executionActual: "local_host" }), "local");
  assert.equal(resolveWorkbenchEnvironment({ executionActual: "local_sandbox" }), "sandbox");
  assert.equal(resolveWorkbenchEnvironment({ executionActual: "ovh_worker" }), "cloud");
  assert.equal(environmentLabel("cloud"), "Cloud");
  assert.equal(terminalTitle("cloud"), "Terminal · Cloud Worker");
  assert.equal(terminalTitle("sandbox", 2), "Terminal · Sandbox 2");
});
