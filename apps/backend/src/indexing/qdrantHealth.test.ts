import { test } from "node:test";
import assert from "node:assert/strict";
import { probeQdrant } from "./qdrantHealth";

test("probeQdrant: unset URL is not_configured, never healthy", async () => {
  const prev = process.env.ORVYN_QDRANT_URL;
  delete process.env.ORVYN_QDRANT_URL;
  try {
    const h = await probeQdrant(undefined);
    assert.equal(h.status, "not_configured");
    assert.equal(h.reachable, false);
  } finally {
    if (prev === undefined) delete process.env.ORVYN_QDRANT_URL;
    else process.env.ORVYN_QDRANT_URL = prev;
  }
});

test("probeQdrant: a dead host is unhealthy", async () => {
  const h = await probeQdrant("http://127.0.0.1:1");
  assert.equal(h.status, "unhealthy");
  assert.equal(h.reachable, false);
});
