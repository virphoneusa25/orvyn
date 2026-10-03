import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsFor, escalate, isSmallEdit, profileFor, runCreditBudget, startRoute, weightFor } from "./routingPolicy";

const today = ["ci:gpt-5.6-luna", "ci:glm-5.3-flash", "ci:glm-5.3", "ci:google/gemini-3.5-flash-lite", "ci:gemini-3.7-flash", "ci:deepseek-v4-pro", "ci:kimi-k3", "fw:accounts/fireworks/models/kimi-k2p7-code", "ci:claude-sonnet-5", "ci:gpt-5.6-sol"];
const full = [...today, "mistral:mistral-small-4-0-26-03", "mistral:codestral-25-08", "nebius:zai-org/GLM-5.3-Flash", "fw:accounts/fireworks/models/glm-5p3-flash", "nebius:zai-org/GLM-5.3", "fw:accounts/fireworks/models/glm-5p3", "nebius:deepseek-ai/DeepSeek-V4-Pro", "gemini:gemini-3.8-flash"];

test("profiles: code, server, deep, auto", () => {
  assert.equal(profileFor({ instruction: "Refactor the React dashboard component" }), "code");
  assert.equal(profileFor({ instruction: "Why is nginx returning 502 on the VPS?" }), "server");
  assert.equal(profileFor({ instruction: "Restart the docker compose stack on my server" }), "server");
  assert.equal(profileFor({ instruction: "anything", composerMode: "server" }), "server");
  assert.equal(profileFor({ instruction: "What should we name our models?", deep: true }), "deep");
  assert.equal(profileFor({ instruction: "Create hello.txt" }), "auto");
});

test("with every provider: the cheap model for the job serves first", () => {
  assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: full }).registryId, "nebius:zai-org/GLM-5.3-Flash");
  assert.equal(startRoute({ profile: "code", instruction: "Build the settings page", availableIds: full }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
  assert.equal(startRoute({ profile: "code", instruction: "Fix the typo in the header", availableIds: full }).registryId, "mistral:codestral-25-08");
  assert.equal(startRoute({ profile: "server", instruction: "nginx 502", availableIds: full }).registryId, "ci:google/gemini-3.5-flash-lite");
  assert.equal(startRoute({ profile: "deep", instruction: "naming", availableIds: full }).registryId, "nebius:deepseek-ai/DeepSeek-V4-Pro");
});

test("Hugging Face routing is an explicit opt-in and prefers its registered GLM route only when enabled", () => {
  const hf = "hf:zai-org/GLM-5.3-Flash:deepinfra";
  const ids = [...full, hf, "hf:zai-org/GLM-5.3:deepinfra"];
  const old = process.env.HUGGINGFACE_ROUTING_ENABLED;
  const oldDefault = process.env.ORVYN_DEFAULT_MODEL_PROVIDER;
  try {
    delete process.env.HUGGINGFACE_ROUTING_ENABLED;
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: ids }).registryId, "nebius:zai-org/GLM-5.3-Flash");
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: [hf] }).registryId, null, "a registered key alone does not silently change auto routing");
    process.env.HUGGINGFACE_ROUTING_ENABLED = "1";
    process.env.ORVYN_DEFAULT_MODEL_PROVIDER = "cheaper_inference";
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: ids }).registryId, hf);
    assert.equal(startRoute({ profile: "auto", instruction: "Implement a feature", availableIds: ["nebius:zai-org/GLM-5.3", "hf:zai-org/GLM-5.3:deepinfra"] }).registryId, "hf:zai-org/GLM-5.3:deepinfra");
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: ["fw:accounts/fireworks/models/glm-5p3-flash", hf] }).registryId, hf);
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: ["fw:accounts/fireworks/models/glm-5p3-flash"] }).registryId, "fw:accounts/fireworks/models/glm-5p3-flash");
  } finally {
    if (old === undefined) delete process.env.HUGGINGFACE_ROUTING_ENABLED; else process.env.HUGGINGFACE_ROUTING_ENABLED = old;
    if (oldDefault === undefined) delete process.env.ORVYN_DEFAULT_MODEL_PROVIDER; else process.env.ORVYN_DEFAULT_MODEL_PROVIDER = oldDefault;
  }
});

test("with today's providers: nothing breaks (each tier falls back)", () => {
  assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: today }).registryId, "ci:glm-5.3-flash");
  assert.equal(startRoute({ profile: "code", instruction: "Fix the typo in the header", availableIds: today }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
  assert.equal(startRoute({ profile: "server", instruction: "nginx", availableIds: today }).registryId, "ci:google/gemini-3.5-flash-lite");
});

test("the production provider preference avoids the slow GLM Flash route without changing stronger lanes", () => {
  const old = process.env.ORVYN_DEFAULT_MODEL_PROVIDER;
  process.env.ORVYN_DEFAULT_MODEL_PROVIDER = "cheaper_inference";
  try {
    assert.equal(startRoute({ profile: "auto", instruction: "x", availableIds: full }).registryId, "ci:glm-5.3-flash");
    assert.equal(startRoute({ profile: "code", instruction: "Build it", availableIds: full }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
    assert.equal(startRoute({ profile: "deep", instruction: "reason", availableIds: full }).registryId, "nebius:deepseek-ai/DeepSeek-V4-Pro");
  } finally {
    if (old === undefined) delete process.env.ORVYN_DEFAULT_MODEL_PROVIDER; else process.env.ORVYN_DEFAULT_MODEL_PROVIDER = old;
  }
});

test("escalation: one step at a time, skips tiers with no model, stops at the top; Sol only when allowed", () => {
  let r = startRoute({ profile: "code", instruction: "Fix the typo", availableIds: full, allowUltra: false });
  const path = [r.registryId];
  for (let n = 0; n < 6; n++) { const next = escalate(r, full); if (!next) break; r = next; path.push(r.registryId); }
  assert.deepEqual(path, ["mistral:codestral-25-08", "fw:accounts/fireworks/models/kimi-k2p7-code", "nebius:zai-org/GLM-5.3", "nebius:deepseek-ai/DeepSeek-V4-Pro"]);
  const top = startRoute({ profile: "deep", instruction: "x", availableIds: full, allowUltra: true });
  assert.equal(escalate(top, full)?.registryId, "ci:gpt-5.6-sol");
});

test("credits: weight × tokens / 1000; budgets per profile, configurable", () => {
  assert.equal(weightFor("fw:accounts/fireworks/models/kimi-k2p7-code"), 4);
  assert.equal(weightFor("ci:gpt-5.6-sol"), 25);
  assert.equal(creditsFor("fw:accounts/fireworks/models/kimi-k2p7-code", { promptTokens: 500_000, completionTokens: 50_000 }), 2200);
  assert.equal(creditsFor("ci:glm-5.3-flash", { promptTokens: 200_000, completionTokens: 20_000 }), 220);
  assert.equal(runCreditBudget("code", {}), 4000);
  assert.equal(runCreditBudget("code", { ORVYN_RUN_CREDITS_CODE: "9000" }), 9000);
  assert.equal(runCreditBudget("auto", { ORVYN_RUN_CREDITS: "0" }), 0);
  assert.equal(isSmallEdit("Fix the typo in the footer"), true);
  assert.equal(isSmallEdit("Build a dashboard with charts and auth"), false);
});
