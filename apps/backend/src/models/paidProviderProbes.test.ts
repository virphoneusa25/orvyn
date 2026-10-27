import test from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "@orvyn/ai-core";
import { refreshDeepSeekRates } from "./deepseekRates";
import { verifyHuggingFace } from "./huggingFaceVerification";
import { verifyFireworksWriting } from "./fireworksVerification";

test("automatic provider refreshes never make paid capability requests, including repeated tenant refreshes", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Unexpected network request"); }) as typeof fetch;
  try {
    for (const refresh of [refreshDeepSeekRates, verifyHuggingFace, verifyFireworksWriting]) {
      const config = { id: "probe-fixture", endpoint: "https://fixture.invalid", apiKey: "fixture" } as ModelConfig;
      await Promise.all(Array.from({length: 20}, () => refresh(config)));
      assert.equal(config.routingVerification?.status, refresh === verifyHuggingFace ? "unverified" : "failed");
      assert.match(config.routingVerification!.reason, refresh === verifyHuggingFace ? /automatic paid probes are disabled/i : /Automatic paid capability probes are disabled/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});
