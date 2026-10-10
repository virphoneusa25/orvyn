import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileOAuthPath, pollMobileHandoff } from "./mobileHandoff.ts";

test("OAuth browser URL contains a public handoff id and challenge, never the secret verifier or session", () => {
  const url = new URL(mobileOAuthPath("github", "public-id", "public-challenge"), "https://app.kernelailabs.com");
  assert.equal(url.searchParams.get("client"), "mobile");
  assert.equal(url.searchParams.get("hid"), "public-id");
  assert.equal(url.searchParams.has("verifier"), false);
  assert.equal(url.searchParams.has("token"), false);
});

test("A pending handoff resolves with exactly the claimed session", async () => {
  let claims = 0;
  const token = await pollMobileHandoff(async () => ++claims === 1 ? { status: "pending" } : { status: "ok", token: "session" }, new AbortController().signal, { wait: async () => undefined });
  assert.equal(token, "session");
  assert.equal(claims, 2);
});

test("Invalid, cancelled and expired handoffs stop instead of looping forever", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(pollMobileHandoff(async () => ({ status: "invalid" }), signal), /expired/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pollMobileHandoff(async () => ({ status: "ok", token: "bad" }), controller.signal), { name: "AbortError" });
  let clock = 0;
  await assert.rejects(pollMobileHandoff(async () => ({ status: "pending" }), signal, { timeoutMs: 2, now: () => clock++, wait: async () => undefined }), /too long/);
});

test("A completed response without a session token cannot sign the user in", async () => {
  await assert.rejects(pollMobileHandoff(async () => ({ status: "ok" }), new AbortController().signal), /expired/);
});
