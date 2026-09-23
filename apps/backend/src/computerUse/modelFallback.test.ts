import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, type ModelConfig, MockAdapter } from "@orvyn/ai-core";
import { decideComputerUseFallback, modelFallbackAllowed, pickCompatibleComputerModel } from "./modelFallback";
import { resolveRuntimeCapabilities } from "./modelComputerCapabilities";
import { stripProviderSecrets } from "./capabilityMatrix";

function cfg(partial: Partial<ModelConfig> & Pick<ModelConfig, "id" | "name">): ModelConfig {
  return {
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:9",
    apiKey: "sk-secret-must-never-leak",
    contextWindow: 8000,
    maxOutputTokens: 1024,
    defaultTemperature: 0.2,
    defaultTopP: 1,
    streaming: true,
    capabilities: { chat: true, code: true, agent: true, tools: true, vision: true, embeddings: false, completion: true, image: false },
    ...partial,
  };
}

function registry(...models: ModelConfig[]) {
  const r = new ModelRegistry();
  for (const m of models) r.register(new MockAdapter(m));
  return r;
}

test("capability matrix: tools imply computerUseViaTools unless explicitly false", () => {
  const open = resolveRuntimeCapabilities(cfg({ id: "gpt", name: "GPT" }));
  assert.equal(open.toolCalling, true);
  assert.equal(open.vision, true);
  assert.equal(open.computerUseViaTools, true);
  assert.equal(open.nativeComputerUse, false);

  const claude = resolveRuntimeCapabilities(
    cfg({ id: "claude", name: "Claude", capabilities: { chat: true, code: true, agent: true, tools: true, vision: true, embeddings: false, completion: true, image: false, computerUseViaTools: false } })
  );
  assert.equal(claude.computerUseViaTools, false);
  assert.equal(claude.nativeComputerUse, false);
});

test("Auto fallback switches to a vision+tools model and preserves requested/actual", () => {
  const claude = new MockAdapter(cfg({ id: "claude", name: "Claude", provider: "anthropic" }));
  const gpt = cfg({ id: "gpt-4o", name: "GPT-4o" });
  const r = registry(claude.config, gpt);
  const decision = decideComputerUseFallback({
    auto: true,
    current: claude,
    registry: r,
    fallbackCount: 0,
  });
  assert.equal(decision.decision.switched, true);
  assert.equal(decision.decision.actualModel, "gpt-4o");
  assert.equal(decision.decision.requestedModel, "auto");
  assert.equal(decision.decision.fallbackCount, 1);
  assert.match(decision.decision.fallbackReason ?? "", /claude/i);
});

test("pinned model is never silently replaced", () => {
  const claude = new MockAdapter(cfg({ id: "claude", name: "Claude", provider: "anthropic" }));
  const r = registry(claude.config, cfg({ id: "gpt-4o", name: "GPT" }));
  const decision = decideComputerUseFallback({
    auto: false,
    pinnedModelId: "claude",
    current: claude,
    registry: r,
    fallbackCount: 0,
  });
  assert.equal(decision.decision.switched, false);
  assert.equal(decision.pinnedBlocked, true);
  assert.equal(decision.decision.actualModel, "claude");
  assert.equal(modelFallbackAllowed(false), false);
});

test("policy disable and allowlist honor enterprise override", () => {
  const claude = new MockAdapter(cfg({ id: "claude", name: "Claude" }));
  const r = registry(claude.config, cfg({ id: "gpt-4o", name: "GPT" }), cfg({ id: "glm", name: "GLM", provider: "glm" }));
  const disabled = decideComputerUseFallback({
    auto: true,
    current: claude,
    registry: r,
    fallbackCount: 0,
    policyDisabled: true,
  });
  assert.equal(disabled.decision.switched, false);

  const allowlisted = decideComputerUseFallback({
    auto: true,
    current: claude,
    registry: r,
    fallbackCount: 0,
    allowlist: ["glm"],
  });
  assert.equal(allowlisted.decision.switched, true);
  assert.equal(allowlisted.decision.actualModel, "glm");
});

test("at most two fallbacks; no infinite switching", () => {
  const claude = new MockAdapter(cfg({ id: "claude", name: "Claude" }));
  const r = registry(claude.config, cfg({ id: "gpt-4o", name: "GPT" }));
  const hit = decideComputerUseFallback({ auto: true, current: claude, registry: r, fallbackCount: 2 });
  assert.equal(hit.decision.switched, false);
  assert.match(hit.decision.fallbackReason ?? "", /limit/i);
});

test("vision-less model is not chosen for visual verification", () => {
  const current = new MockAdapter(cfg({ id: "claude", name: "Claude" }));
  const r = registry(
    current.config,
    cfg({
      id: "text-only",
      name: "Text",
      capabilities: { chat: true, code: true, agent: true, tools: true, vision: false, embeddings: false, completion: true, image: false },
    })
  );
  assert.equal(pickCompatibleComputerModel(r, "claude", { requireVision: true }), undefined);
});

test("fallback audit never includes API keys or filesystem credentials", () => {
  const current = new MockAdapter(cfg({ id: "claude", name: "Claude" }));
  const r = registry(current.config, cfg({ id: "gpt-4o", name: "GPT" }));
  const next = pickCompatibleComputerModel(r, "claude")!;
  const safe = stripProviderSecrets(next);
  assert.equal(safe.id, "gpt-4o");
  assert.equal("apiKey" in safe, false);
  assert.doesNotMatch(JSON.stringify(safe), /sk-secret/);
});
