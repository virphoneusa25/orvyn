import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiUrl, resolveSocketUrl, validatedMobileOrigin } from "./mobilePlatform.ts";

test("Cloud keeps relative requests; native requests use the configured cloud origin", () => {
  assert.equal(resolveApiUrl("/api/v1/sessions"), "/api/v1/sessions");
  assert.equal(resolveApiUrl("/api/v1/sessions", "https://app.kernelailabs.com"), "https://app.kernelailabs.com/api/v1/sessions");
  assert.equal(resolveApiUrl("/api/v1/agent/stream/runs/r/events?after=4", "https://staging.orvyn.virphoneusa.com"), "https://staging.orvyn.virphoneusa.com/api/v1/agent/stream/runs/r/events?after=4");
  assert.equal(resolveApiUrl("/api/v1/artifacts/a/preview?ticket=x", "https://app.kernelailabs.com"), "https://app.kernelailabs.com/api/v1/artifacts/a/preview?ticket=x");
});

test("Mobile configuration rejects HTTP, credentials, and paths", () => {
  for (const value of ["http://app.kernelailabs.com", "https://token@app.kernelailabs.com", "https://app.kernelailabs.com/api", "https://app.kernelailabs.com?token=x", "invalid"]) assert.throws(() => validatedMobileOrigin(value));
});

test("Socket uses the cloud host with a one-time ticket, including reserved characters", () => {
  const url = new URL(resolveSocketUrl("https://app.kernelailabs.com", "a/b+c"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "app.kernelailabs.com");
  assert.equal(url.pathname, "/ws/chat");
  assert.equal(url.searchParams.get("ticket"), "a/b+c");
  assert.equal(url.searchParams.has("token"), false);
});
