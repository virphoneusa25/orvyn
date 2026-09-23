import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executionLabel,
  routeExecutionTarget,
  runtimeLocation,
} from "./ExecutionTarget";
import { classifyExecutionHints } from "./classifyExecution";

test("explicit Local never becomes Cloud", () => {
  const d = routeExecutionTarget({ requested: "local_host", requiresRemote: true, isBackground: true });
  assert.equal(d.requested, "local_host");
  assert.equal(d.actual, "local_host");
  assert.match(d.reason, /User selected Local/);
});

test("explicit Cloud never becomes Local", () => {
  const d = routeExecutionTarget({ requested: "ovh_worker", hasLocalProject: true });
  assert.equal(d.actual, "ovh_worker");
  assert.match(d.reason, /User selected Cloud/);
});

test("explicit Sandbox stays Sandbox", () => {
  const d = routeExecutionTarget({ requested: "local_sandbox", hasLocalProject: true });
  assert.equal(d.actual, "local_sandbox");
});

test("Auto + local project + Code → local_host", () => {
  const d = routeExecutionTarget({ requested: "auto", mode: "code", hasLocalProject: true });
  assert.equal(d.actual, "local_host");
  assert.equal(executionLabel(d.actual), "Local");
});

test("Auto + Server / Deploy → ovh_worker", () => {
  assert.equal(routeExecutionTarget({ requested: "auto", mode: "server", hasLocalProject: true }).actual, "ovh_worker");
  assert.equal(routeExecutionTarget({ requested: "auto", mode: "deploy", hasLocalProject: true }).actual, "ovh_worker");
});

test("Auto + risky command → local_sandbox", () => {
  const d = routeExecutionTarget({ requested: "auto", mode: "code", hasLocalProject: true, isRisky: true });
  assert.equal(d.actual, "local_sandbox");
  assert.equal(executionLabel(d.actual), "Local Sandbox");
});

test("Auto + background mission → ovh_worker", () => {
  const d = routeExecutionTarget({ requested: "auto", hasLocalProject: true, isBackground: true });
  assert.equal(d.actual, "ovh_worker");
});

test("Auto without a local project stays Local (virtual workspace / artifacts)", () => {
  const d = routeExecutionTarget({ requested: "auto", mode: "code", hasLocalProject: false });
  assert.equal(d.actual, "local_host");
});

test("Auto + artifact request without a project stays Local", () => {
  const d = routeExecutionTarget({ requested: "auto", hasLocalProject: false, isArtifact: true });
  assert.equal(d.actual, "local_host");
});

test("invalid requested value is treated as Auto", () => {
  const d = routeExecutionTarget({ requested: "wherever", hasLocalProject: true });
  assert.equal(d.requested, "auto");
  assert.equal(d.actual, "local_host");
});

test("runtime location: in-process local backend stays LOCAL, cloud uses LOCAL_HOST", () => {
  assert.equal(runtimeLocation("local_host", { inProcessLocal: true }), "LOCAL");
  assert.equal(runtimeLocation("local_host"), "LOCAL_HOST");
  assert.equal(runtimeLocation("local_sandbox"), "LOCAL_SANDBOX");
  assert.equal(runtimeLocation("ovh_worker"), "OVH_WORKER");
});

test("Auto routing examples from prompt classification", () => {
  const tests = classifyExecutionHints("Fix the failing tests locally. Do not use Cloud.", "auto");
  assert.equal(tests.isLocalCoding, true);
  assert.equal(routeExecutionTarget({ requested: "auto", hasLocalProject: true, ...tests }).actual, "local_host");

  const visual = classifyExecutionHints("Start this dashboard locally, fix the visible issue, and verify it.");
  assert.equal(visual.isVisual, true);
  assert.equal(routeExecutionTarget({ requested: "auto", hasLocalProject: true, ...visual }).actual, "local_host");

  const sandbox = classifyExecutionHints("Run this untrusted project and tell me why it crashes.");
  assert.equal(sandbox.isRisky, true);
  assert.equal(routeExecutionTarget({ requested: "auto", hasLocalProject: true, ...sandbox }).actual, "local_sandbox");

  const cloud = classifyExecutionHints("Deploy this service to my OVH server.");
  assert.equal(cloud.requiresRemote, true);
  assert.equal(routeExecutionTarget({ requested: "auto", hasLocalProject: true, ...cloud }).actual, "ovh_worker");

  const logo = classifyExecutionHints("Generate a logo and give me a PNG.");
  assert.equal(logo.isArtifact, true);
  assert.equal(routeExecutionTarget({ requested: "auto", hasLocalProject: false, ...logo }).actual, "local_host");
});
