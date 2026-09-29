import { test } from "node:test";
import assert from "node:assert/strict";
import { pollRetryDelayMs } from "./runPollRetry.ts";

test("a failing run poll retries gently instead of giving up", () => {
  assert.equal(pollRetryDelayMs(401) >= 1000, true); // auth blip — recovers soon
  assert.equal(pollRetryDelayMs(502) >= 1000, true); // deploy window
  assert.equal(pollRetryDelayMs(404) > pollRetryDelayMs(401), true); // backend forgot the run — slowest
});
