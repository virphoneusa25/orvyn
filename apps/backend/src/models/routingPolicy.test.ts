import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsFor, escalate, isSmallEdit, profileFor, runCreditBudget, startRoute, weightFor } from "./routingPolicy";

const today = ["ci:gpt-5.6-luna", "fw:accounts/fireworks/models/deepseek-v4p1-flash", "fw:accounts/fireworks/models/glm-5p3", "fw:accounts/fireworks/models/kimi-k2p7-code", "ci:claude-sonnet-5", "ci:gpt-5.6-sol"];
const full = [...today, "mistral:mistral-small-4-0-26-03", "mistral:codestral-25-08", "openrouter:deepseek/deepseek-v3.2", "openrouter:minimax/minimax-m2.5", "gemini:gemini-3.8-flash"];

test("profiles: code, server, deep, auto", () => {
  assert.equal(profileFor({ instruction: "Refactor the React dashboard component" }), "code");
  assert.equal(profileFor({ instruction: "Why is nginx returning 502 on the VPS?" }), "server");
  assert.equal(profileFor({ instruction: "Restart the docker compose stack on my server" }), "server");
  assert.equal(profileFor({ instruction: "anything", composerMode: "server" }), "server");
  assert.equal(profileFor({ instruction: "What should we name our models?", deep: true }), "deep");
  assert.equal(profileFor({ instruction: "Create hello.txt" }), "auto");
});

test("with every provider: the cheap model for the job serves first", () => {
  assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: full }).registryId, "openrouter:deepseek/deepseek-v3.2");
  assert.equal(startRoute({ profile: "code", instruction: "Build the settings page", availableIds: full }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
  assert.equal(startRoute({ profile: "code", instruction: "Fix the typo in the header", availableIds: full }).registryId, "mistral:codestral-25-08");
  assert.equal(startRoute({ profile: "server", instruction: "nginx 502", availableIds: full }).registryId, "gemini:gemini-3.8-flash");
  assert.equal(startRoute({ profile: "deep", instruction: "naming", availableIds: full }).registryId, "gemini:gemini-3.8-flash");
});

test("with today's providers: nothing breaks (each tier falls back)", () => {
  assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: today }).registryId, "fw:accounts/fireworks/models/deepseek-v4p1-flash");
  assert.equal(startRoute({ profile: "code", instruction: "Fix the typo in the header", availableIds: today }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
  assert.equal(startRoute({ profile: "server", instruction: "nginx", availableIds: today }).registryId, "fw:accounts/fireworks/models/glm-5p3");
});

test("escalation: one step at a time, skips tiers with no model, stops at the top; Sol only when allowed", () => {
  let r = startRoute({ profile: "code", instruction: "Fix the typo", availableIds: full, allowUltra: false });
  const path = [r.registryId];
  for (let n = 0; n < 6; n++) { const next = escalate(r, full); if (!next) break; r = next; path.push(r.registryId); }
  assert.deepEqual(path, ["mistral:codestral-25-08", "fw:accounts/fireworks/models/kimi-k2p7-code", "fw:accounts/fireworks/models/glm-5p3", "ci:claude-sonnet-5"]);
  const top = startRoute({ profile: "deep", instruction: "x", availableIds: full, allowUltra: true });
  assert.equal(escalate(escalate(top, full)!, full)?.registryId, "ci:gpt-5.6-sol");
});

test("credits: weight × tokens / 1000; budgets per profile, configurable", () => {
  assert.equal(weightFor("fw:accounts/fireworks/models/kimi-k2p7-code"), 4);
  assert.equal(weightFor("ci:gpt-5.6-sol"), 25);
  assert.equal(creditsFor("fw:accounts/fireworks/models/kimi-k2p7-code", { promptTokens: 500_000, completionTokens: 50_000 }), 2200);
  assert.equal(creditsFor("openrouter:deepseek/deepseek-v3.2", { promptTokens: 200_000, completionTokens: 20_000 }), 220);
  assert.equal(runCreditBudget("code", {}), 4000);
  assert.equal(runCreditBudget("code", { ORVYN_RUN_CREDITS_CODE: "9000" }), 9000);
  assert.equal(runCreditBudget("auto", { ORVYN_RUN_CREDITS: "0" }), 0);
  assert.equal(isSmallEdit("Fix the typo in the footer"), true);
  assert.equal(isSmallEdit("Build a dashboard with charts and auth"), false);
});
