// apps/backend/src/services/modelRetries.test.ts
//
// Retry logic is invisible until a provider hiccups mid-mission, and wrong
// retries are worse than none (duplicated output, tens of seconds of backoff
// on a dead key, or replaying a cancelled call). These pin the distinctions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientError, withModelRetries } from "./modelRetries";

function err(message: string, name?: string): Error {
  const e = new Error(message);
  if (name) e.name = name;
  return e;
}

test("transient classification: rate limits and network failures retry, the rest do not", () => {
  assert.equal(isTransientError(err('Model "x" returned HTTP 429: rate limited')), true);
  assert.equal(isTransientError(err('Model "x" returned HTTP 503: overloaded')), true);
  assert.equal(isTransientError(err("fetch failed")), true);
  assert.equal(isTransientError(err("socket hang up")), true);

  // Permanent: auth, bad request, and the out-of-credits 429.
  assert.equal(isTransientError(err('Model "x" returned HTTP 401: invalid key')), false);
  assert.equal(isTransientError(err('Model "x" returned HTTP 400: bad request')), false);
  assert.equal(
    isTransientError(err('HTTP 429: ... "type":"insufficient_quota" ... no credits remaining')),
    false
  );
  // Deliberate cancellation is never retried.
  assert.equal(isTransientError(err("The operation was aborted", "AbortError")), false);
});

test("retries a transient failure and succeeds on a later attempt", async () => {
  let calls = 0;
  const result = await withModelRetries(
    async () => {
      calls++;
      if (calls < 3) throw err("HTTP 503: overloaded");
      return "ok";
    },
    { maxAttempts: 4, baseDelayMs: 1 }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("does not retry a permanent error", async () => {
  let calls = 0;
  await assert.rejects(
    withModelRetries(
      async () => {
        calls++;
        throw err('HTTP 401: invalid key');
      },
      { maxAttempts: 4, baseDelayMs: 1 }
    ),
    /invalid key/
  );
  assert.equal(calls, 1);
});

test("does not retry an AbortError — Stop must stop immediately", async () => {
  let calls = 0;
  await assert.rejects(
    withModelRetries(
      async () => {
        calls++;
        throw err("aborted", "AbortError");
      },
      { maxAttempts: 4, baseDelayMs: 1 }
    ),
    (e: Error) => e.name === "AbortError"
  );
  assert.equal(calls, 1);
});

test("gives up after maxAttempts on persistent transient errors", async () => {
  let calls = 0;
  await assert.rejects(
    withModelRetries(
      async () => {
        calls++;
        throw err("HTTP 502: bad gateway");
      },
      { maxAttempts: 3, baseDelayMs: 1 }
    ),
    /bad gateway/
  );
  assert.equal(calls, 3);
});
