import test from "node:test";
import assert from "node:assert/strict";
import type { AIModelProvider } from "@orvyn/ai-core";
import { UsageService } from "./UsageService";

for (const method of ["generate", "stream", "image"] as const) {
  test(`${method}: acknowledgement failure records one successful provider event`, async () => {
    const usage = new UsageService();
    const failure = new Error("PostgreSQL acknowledgement unavailable");
    let recordings = 0;
    usage.recordAsync = async (event) => {
      recordings++;
      usage.record(event);
      throw failure;
    };
    const provider = usage.wrap({
      config: { id: "durability-test", provider: "test" },
      generate: async () => ({ content: "ok", finishReason: "stop" }),
      stream: async function* () { yield { delta: "ok", done: true }; },
      generateImage: async () => ({}),
      healthCheck: async () => true,
      supportsTools: () => false,
      supportsVision: () => false,
    } as unknown as AIModelProvider);
    await assert.rejects(async () => {
      if (method === "generate") await provider.generate({ messages: [] });
      else if (method === "stream") {
        for await (const chunk of provider.stream({ messages: [] })) assert.equal(chunk.delta, "ok");
      } else await provider.generateImage!({ prompt: "test" });
    }, (error) => error === failure);
    assert.equal(recordings, 1);
    assert.equal(usage.totals().requests, 1);
    assert.equal(usage.totals().errors, 0);
  });
}
