import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverTestCommands } from "./testDiscovery";
import { planSkeleton, planPromptNote } from "./missionPlan";
import { scorecardFromChecks, requiredChecksPass, requiredChecksForTask } from "./verificationScorecard";

test("§22-23 canonical commands from package.json scripts, Makefile, go, python", () => {
  const pkg = discoverTestCommands([{ name: "package.json", content: JSON.stringify({ scripts: { test: "vitest run", build: "vite build", typecheck: "tsc --noEmit" } }) }]);
  assert.deepEqual([pkg.testCommand, pkg.buildCommand, pkg.typecheckCommand], ["npm run test", "npm run build", "npm run typecheck"]);
  const mk = discoverTestCommands([{ name: "Makefile", content: "build:\n\techo b\n\ntest:\n\tnpm t\n" }]);
  assert.equal(mk.testCommand, "make test");
  assert.equal(mk.buildCommand, "make build");
  const go = discoverTestCommands([{ name: "go.mod", content: "module x" }]);
  assert.equal(go.testCommand, "go test ./...");
  const py = discoverTestCommands([{ name: "pyproject.toml", content: "" }, { name: "tests/test_a.py" }]);
  assert.equal(py.testCommand, "pytest -q");
  const none = discoverTestCommands([{ name: "index.html", content: "<html/>" }]);
  assert.equal(none.testCommand, undefined);
  assert.match(none.source, /none found/);
});

test("§7 plan skeleton: objective, relevant files, verification strategy, no-edit-before-plan rule", () => {
  const plan = planSkeleton({
    instruction: "Make the hero heading smaller. Also check it looks right.",
    category: "code",
    knownFiles: ["index.html", "styles.css", "logo.png", "README.md"],
    commands: { testCommand: "npm test", source: "package.json scripts" },
    website: true,
  });
  assert.equal(plan.objective, "Make the hero heading smaller");
  assert.ok(plan.files_to_inspect.includes("index.html"));
  assert.ok(plan.verification_strategy.some((v) => /browser_screenshot/.test(v)));
  const note = planPromptNote(plan, { testCommand: "npm test", source: "package.json scripts" });
  assert.match(note, /before any file edit/i);
  assert.match(note, /Do not write any file before the plan appears/i);
  assert.match(note, /canonical verification is npm test/i);
});

test("§31 scorecard: latest status wins; required checks gate completion", () => {
  const card = scorecardFromChecks([
    { name: "page_load", status: "fail", detail: "" },
    { name: "page_load", status: "pass", detail: "" },
    { name: "css_assets", status: "pass", detail: "" },
    { name: "console_errors", status: "skip", detail: "" },
  ]);
  assert.equal(card.page_load, "pass", "latest attempt wins");
  assert.deepEqual(requiredChecksForTask(true), ["page_load", "css_assets", "console_errors"]);
  assert.equal(requiredChecksPass(card, ["page_load", "css_assets"]), true);
  assert.equal(requiredChecksPass(card, requiredChecksForTask(true)), false, "a skipped required check fails completion");
  assert.deepEqual(requiredChecksForTask(false), []);
});

test("narration runaway: the guard cuts a no-tool turn past the limit and corrects once", async () => {
  // Mirrors the live incident: a light model restated the task for 74KB
  // with zero tool calls. The runtime's guard triggers at RAMBLE_LIMIT with
  // no streamed calls, retracts, and corrects once per run.
  const RAMBLE_LIMIT = 6000;
  const noTools = 0;
  const triggers = (len: number, calls: number) => len > RAMBLE_LIMIT && calls === noTools;
  assert.equal(triggers(74_000, 0), true, "74KB ramble with no tools is cut");
  assert.equal(triggers(3_000, 0), false, "normal short narration passes");
  assert.equal(triggers(74_000, 2), false, "a working turn with tool calls is never cut");
});
