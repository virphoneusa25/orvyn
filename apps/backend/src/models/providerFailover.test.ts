import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyModelFailure, clearModelAvailability, clearProviderHealth, isProviderCoolingDown, isRouteBlocked,
  markProviderFailure, markProviderSuccess, providerHealthScore,
} from "./modelAvailability";
import { NEBIUS_CURATED, sameModelElsewhere } from "./modelEquivalents";
import { startRoute, TIERS } from "./routingPolicy";

const FW_GLM = "fw:accounts/fireworks/models/glm-5p3";
const NB_GLM = "nebius:zai-org/GLM-5.3";
const FW_KIMI = "fw:accounts/fireworks/models/kimi-k2p7-code";
const NB_KIMI = "nebius:moonshotai/Kimi-K2.7-Code";
const HF_GLM = "hf:zai-org/GLM-5.3:deepinfra";

test("failures are classified: model vs provider vs auth vs the request itself", () => {
  assert.equal(classifyModelFailure(new Error('Model "x" stream failed: HTTP 404: Model not found, inaccessible, and/or not deployed')), "model");
  assert.equal(classifyModelFailure(new Error('Model "x" stream failed: HTTP 429: rate limit exceeded')), "provider");
  assert.equal(classifyModelFailure(new Error('Model "x" stream failed: HTTP 503: Service Unavailable')), "provider");
  assert.equal(classifyModelFailure(new Error("fetch failed")), "provider");
  assert.equal(classifyModelFailure(new Error("connect ETIMEDOUT 10.0.0.1:443")), "provider");
  assert.equal(classifyModelFailure(new Error('Model "x" returned HTTP 401: invalid api key')), "auth");
  assert.equal(classifyModelFailure(new Error('Model "x" returned HTTP 402: insufficient credits')), "auth");
  // The request itself was bad: another provider would fail the same way.
  assert.equal(classifyModelFailure(new Error('Model "x" returned HTTP 400: tools[3].function.parameters is invalid')), null);
  assert.equal(classifyModelFailure(new Error("HTTP 400: context length exceeded")), null);
  assert.equal(classifyModelFailure(new Error("")), null);
});

test("a failing provider cools down (doubling on repeats) and one success resets it", () => {
  clearProviderHealth();
  const now = 1_000_000;
  assert.equal(markProviderFailure(FW_GLM, "provider", "HTTP 503", now), 60_000);
  assert.ok(isProviderCoolingDown(FW_KIMI, now + 1000), "the whole provider cools down, not just one model");
  assert.ok(!isProviderCoolingDown(NB_GLM, now + 1000));
  assert.ok(!isProviderCoolingDown(FW_GLM, now + 61_000));
  assert.equal(markProviderFailure(FW_GLM, "provider", "HTTP 503", now), 120_000);
  assert.equal(markProviderFailure(FW_GLM, "provider", "HTTP 503", now), 240_000);
  assert.equal(providerHealthScore(FW_GLM, now), 0);
  markProviderSuccess(FW_GLM);
  assert.ok(!isProviderCoolingDown(FW_GLM, now));
  assert.equal(markProviderFailure(FW_GLM, "provider", "HTTP 503", now), 60_000, "streak reset by the success");
  assert.equal(markProviderFailure(NB_GLM, "auth", "HTTP 401", now), 30 * 60_000);
  clearProviderHealth();
});

test("same model on the other provider first; then the tier's next model", () => {
  clearProviderHealth();
  clearModelAvailability();
  const all = new Set([FW_GLM, NB_GLM, FW_KIMI, NB_KIMI, "mistral:zai-glm-5-3"]);
  assert.deepEqual(sameModelElsewhere(FW_GLM, (id) => all.has(id)), [NB_GLM, "mistral:zai-glm-5-3"]);
  const oldHfRouting = process.env.HUGGINGFACE_ROUTING_ENABLED;
  try {
    process.env.HUGGINGFACE_ROUTING_ENABLED = "1";
    assert.deepEqual(sameModelElsewhere(FW_GLM, (id) => id === HF_GLM), [HF_GLM], "Hugging Face can serve as an opt-in same-model fallback");
    delete process.env.HUGGINGFACE_ROUTING_ENABLED;
    assert.deepEqual(sameModelElsewhere(FW_GLM, (id) => id === HF_GLM), [], "the HF key alone does not enable provider failover");
  } finally {
    if (oldHfRouting === undefined) delete process.env.HUGGINGFACE_ROUTING_ENABLED;
    else process.env.HUGGINGFACE_ROUTING_ENABLED = oldHfRouting;
  }
  assert.deepEqual(sameModelElsewhere(NB_KIMI, (id) => all.has(id)), [FW_KIMI]);
  assert.deepEqual(sameModelElsewhere("fw:unknown", (id) => all.has(id)), []);

  // Routing: Fireworks first; while Fireworks cools down the code run starts on Nebius's Kimi K2.7 Code.
  const ids = [...all];
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, FW_KIMI);
  markProviderFailure(FW_KIMI, "provider", "HTTP 429");
  assert.ok(isRouteBlocked(FW_GLM));
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, NB_KIMI);
  assert.deepEqual(sameModelElsewhere(NB_GLM, (id) => all.has(id)), ["mistral:zai-glm-5-3"], "a cooling provider is not offered");
  clearProviderHealth();
});

test("the curated Nebius set serves every agent tier as a second provider", () => {
  const curated = new Set(NEBIUS_CURATED.map((m) => `nebius:${m.id}`));
  for (const tier of ["utility", "code-helper", "auto", "agent", "code", "research", "vision", "premium", "heavy", "deep"] as const) {
    assert.ok(TIERS[tier].candidates.some((id) => curated.has(id)), `${tier} has a Nebius candidate`);
  }
  for (const id of Object.values(TIERS).flatMap((t) => t.candidates).filter((id) => id.startsWith("nebius:"))) {
    assert.ok(curated.has(id), `${id} is in the curated set`);
  }
  // With only Nebius configured, each profile starts on the role model.
  const ids = [...curated];
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, NB_KIMI);
  assert.equal(startRoute({ profile: "auto", instruction: "Create hello.txt", availableIds: ids }).registryId, "nebius:zai-org/GLM-5.3-Flash");
  assert.equal(startRoute({ profile: "server", instruction: "nginx 502", availableIds: ids }).registryId, "nebius:zai-org/GLM-5.3");
});
