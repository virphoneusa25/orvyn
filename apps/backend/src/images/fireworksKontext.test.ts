import { test } from "node:test";
import assert from "node:assert/strict";
import { fireworksKontextImage, interpretKontextPoll } from "./fireworksKontext";

test("a Ready poll without sample is not success", () => {
  assert.equal(interpretKontextPoll({ status: "Ready" }).error?.includes("result.sample"), true);
  assert.equal(interpretKontextPoll({ status: "Pending" }).pending, true);
});

test("request acceptance is not a finished image", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/get_result")) {
      return { ok: true, status: 200, json: async () => ({ status: "Ready", result: { sample: "https://cdn.example/hero.png" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ request_id: "req-1" }) };
  }) as unknown as typeof fetch;
  const out = await fireworksKontextImage({
    endpoint: "https://api.fireworks.ai/inference",
    apiKey: "test-key",
    modelId: "accounts/fireworks/models/flux-kontext-pro",
    prompt: "hero",
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(out.url, "https://cdn.example/hero.png");
  assert.equal(calls.length, 2);
});

test("provider error status does not yield a url", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/get_result")) return { ok: true, status: 200, json: async () => ({ status: "Failed" }) };
    return { ok: true, status: 200, json: async () => ({ request_id: "req-2" }) };
  }) as unknown as typeof fetch;
  await assert.rejects(
    fireworksKontextImage({
      endpoint: "https://api.fireworks.ai/inference",
      apiKey: "test-key",
      modelId: "accounts/fireworks/models/flux-kontext-max",
      prompt: "hero",
      fetchImpl,
      sleep: async () => {},
    }),
    /Failed/
  );
});
