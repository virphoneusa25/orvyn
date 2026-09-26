import { test } from "node:test";
import assert from "node:assert/strict";
import { clearModelAvailability, isModelNotFound, isModelUnavailable, markModelUnavailable } from "./modelAvailability";
import { startRoute } from "./routingPolicy";

test("a provider's 'model not found' is recognised; other errors are not", () => {
  assert.ok(isModelNotFound(new Error('Model "fw:accounts/fireworks/models/kimi-k2p7-code" stream failed: HTTP 404: {"error":{"message":"Model not found, inaccessible, and/or not deployed","param":"model","code":"NOT_FOUND"}}')));
  assert.ok(isModelNotFound(new Error("HTTP 400: The model `gpt-x` does not exist or you do not have access to it.")));
  assert.ok(!isModelNotFound(new Error("HTTP 429: rate limit exceeded")));
  assert.ok(!isModelNotFound(new Error("HTTP 500: internal error")));
});

test("a missing model is skipped by the routing policy until it expires", () => {
  clearModelAvailability();
  const ids = ["fw:accounts/fireworks/models/kimi-k2p7-code", "fw:accounts/fireworks/models/glm-5p3"];
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, ids[0]);
  markModelUnavailable(ids[0]!, "404");
  assert.ok(isModelUnavailable(ids[0]!));
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, ids[1]);
  assert.ok(!isModelUnavailable(ids[0]!, Date.now() + 7 * 3600_000), "expires after the TTL");
  clearModelAvailability();
});
