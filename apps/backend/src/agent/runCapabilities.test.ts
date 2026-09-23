import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_CHIP_TO_AGENT } from "./modes";
import {
  capabilityGapNotes,
  chatCapabilityPrompt,
  composerModeOverlay,
  looksLikeActionRequest,
  renderCapabilityPrompt,
  summarizeCapabilities,
} from "./runCapabilities";

const FULL = [
  "read_file",
  "edit_file",
  "terminal",
  "git_commit",
  "browser_open",
  "desktop_screenshot",
  "computer_click",
  "generate_image",
  "mcp_call",
  "search_capabilities",
].map((name) => ({ name, permission: "allowed" }));

test("ssh_exec counts as terminal even without a local shell tool", () => {
  const caps = summarizeCapabilities([{ name: "ssh_exec", permission: "allowed" }], { modelTools: true, executionLabel: "Cloud" });
  assert.equal(caps.terminal, true);
  assert.match(renderCapabilityPrompt(caps), /SSH: available/);
});

test("allowed and ask tools count as available; denied terminal does not", () => {
  const caps = summarizeCapabilities(
    [
      { name: "read_file", permission: "allowed" },
      { name: "edit_file", permission: "ask" },
      { name: "terminal", permission: "denied" },
      { name: "run_command", permission: "denied" },
      { name: "desktop_screenshot", permission: "denied" },
    ],
    { modelTools: true, executionLabel: "Local" }
  );
  assert.equal(caps.filesystemRead, true);
  assert.equal(caps.filesystemWrite, true);
  assert.equal(caps.terminal, false);
  assert.equal(caps.desktop, false);
  const prompt = renderCapabilityPrompt(caps);
  assert.match(prompt, /execution: Local/);
  assert.match(prompt, /Edit and create files: available/);
  assert.match(prompt, /Terminal, tests, builds, dev servers, and SSH: not available/);
  assert.doesNotMatch(prompt, /let the user/i);
  assert.doesNotMatch(prompt, /turn by turn/i);
});

test("a run with a terminal does not instruct a global denial", () => {
  const prompt = renderCapabilityPrompt(
    summarizeCapabilities(FULL, { modelTools: true, executionLabel: "Cloud" })
  );
  assert.match(prompt, /Terminal, tests, builds, dev servers, and SSH: available/);
  assert.match(prompt, /Desktop and computer-use in this session: available/);
  assert.match(prompt, /Browser: available/);
  assert.doesNotMatch(prompt, /cannot execute/i);
  assert.doesNotMatch(prompt, /let the user/i);
  assert.doesNotMatch(prompt, /I can't/i);
});

test("chat describes mounted tools and an empty registry stays honest", () => {
  const mounted = chatCapabilityPrompt(["terminal", "read_file", "desktop_screenshot", "browser_open"]);
  assert.match(mounted, /run a terminal/);
  assert.match(mounted, /desktop session/);
  assert.match(mounted, /does not execute tools/);
  assert.doesNotMatch(mounted, /let the user/i);
  const empty = chatCapabilityPrompt([]);
  assert.match(empty, /No project tools are mounted/);
  assert.doesNotMatch(empty, /cannot use a terminal/i);
});

test("action detection nudges engineering work and leaves capability questions alone", () => {
  assert.equal(looksLikeActionRequest("hi, what can you actually do? Can you co-work yet?"), false);
  assert.equal(looksLikeActionRequest("explain this project"), false);
  assert.equal(looksLikeActionRequest("Fix the login bug and run the tests"), true);
  assert.equal(looksLikeActionRequest("Generate a virphone logo png"), true);
  assert.equal(looksLikeActionRequest("Inspect the authentication system"), true);
  assert.equal(looksLikeActionRequest("CAN YOU LOGIN TO MY SERVER?"), true);
});

test("desktop gap is specific and does not cancel the rest of the task", () => {
  const caps = summarizeCapabilities(
    [{ name: "edit_file", permission: "allowed" }, { name: "terminal", permission: "allowed" }],
    { modelTools: true, executionLabel: "Local" }
  );
  const notes = capabilityGapNotes("Start the app and take a screenshot to verify the layout", caps);
  assert.ok(notes.some((n) => /Desktop verification is unavailable/.test(n)));
  assert.match(notes.join(" "), /edits and tests/);
});

test("server and automate chips are executable; research stays read-only", () => {
  assert.equal(MODE_CHIP_TO_AGENT.server, "agent");
  assert.equal(MODE_CHIP_TO_AGENT.automate, "agent");
  assert.equal(MODE_CHIP_TO_AGENT.deploy, "agent");
  assert.equal(MODE_CHIP_TO_AGENT.research, "research");
  assert.match(composerModeOverlay("server", "agent"), /not a read-only/);
  assert.match(composerModeOverlay("automate", "agent"), /multiple steps/);
  assert.match(composerModeOverlay("research", "research"), /read-only/);
  assert.match(composerModeOverlay("code", "agent"), /terminal/);
});
