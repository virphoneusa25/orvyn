import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError, classifyProviderText, providerBlockUserMessage } from "./providerErrors";

test("Claude-style computer-use block is a provider error, not a Desktop failure", () => {
  const err = classifyProviderError(new Error("Computer-use is blocked on Claude usage"), "anthropic");
  assert.ok(err);
  assert.equal(err.code, "PROVIDER_CAPABILITY_BLOCKED");
  assert.equal(err.capability, "computer_use");
  assert.equal(err.kind, "provider_computer_use_blocked");
  assert.equal(err.retryable, false);
  assert.equal(err.provider, "anthropic");
});

test("policy restriction and missing tools/vision normalize separately", () => {
  assert.equal(classifyProviderText("I cannot control the computer")?.code, "PROVIDER_POLICY_RESTRICTION");
  assert.equal(classifyProviderError(new Error("this model does not support tools"))?.code, "PROVIDER_TOOL_NOT_SUPPORTED");
  assert.equal(classifyProviderError(new Error("does not support vision"))?.code, "PROVIDER_VISION_UNSUPPORTED");
});

test("ordinary provider errors are not classified as computer-use blocks", () => {
  assert.equal(classifyProviderError(new Error("rate limit exceeded")), null);
  assert.equal(classifyProviderError(new Error("connection reset")), null);
});

test("pinned block never claims Desktop is unavailable", () => {
  const err = classifyProviderText("Computer-use is blocked on Claude usage", "claude")!;
  const msg = providerBlockUserMessage(err, true);
  assert.match(msg, /cannot perform computer-use/i);
  assert.doesNotMatch(msg, /desktop unavailable/i);
  assert.match(msg, /still available/i);
});

test("Auto block is a compact model line", () => {
  const err = classifyProviderText("Computer use is blocked", "claude")!;
  assert.match(providerBlockUserMessage(err, false), /cannot use computer control/i);
});
