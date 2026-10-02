import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FetchAttemptMemory,
  classifyWebFetchFailure,
  firstFetchUrlPerHost,
  isFetchProxyUrl,
  modelFetchRecovery,
  sanitizeToolErrorForUser,
  userFacingFetchError,
} from "./webFetchRecovery";

test("401/403 classify as auth or bot-block, not unknown", () => {
  assert.equal(classifyWebFetchFailure("HTTP 401 Forbidden"), "AUTH_REQUIRED");
  assert.equal(classifyWebFetchFailure("HTTP 403 Forbidden. Cloudflare"), "BOT_BLOCKED");
  assert.equal(classifyWebFetchFailure("HTTP 404"), "NOT_FOUND");
  assert.equal(classifyWebFetchFailure("OpenShell will not allow host *"), "HOST_POLICY_BLOCKED");
});

test("jina and similar proxies are never a valid fetch fallback", () => {
  assert.equal(isFetchProxyUrl("https://r.jina.ai/https://www.virphoneusa.com/pricing"), true);
  assert.equal(isFetchProxyUrl("https://www.virphoneusa.com/pricing"), false);
});

test("user-facing fetch errors never mention OpenShell or host *", () => {
  const raw = "HTTP 401 Forbidden. Do not retry fetch_url. OpenShell will not allow host *; request_network_access.";
  const shown = sanitizeToolErrorForUser(raw, "https://www.virphoneusa.com/contact");
  assert.match(shown, /Could not read virphoneusa.com/);
  assert.doesNotMatch(shown, /OpenShell|host \*|request_network_access|fetch_url/i);
});

test("one 401 blocks every later path on the same host, including www", () => {
  const mem = new FetchAttemptMemory();
  mem.remember("https://www.virphoneusa.com/", "HTTP 401 Forbidden");
  const pricing = mem.shouldSkip("https://www.virphoneusa.com/pricing");
  assert.equal(pricing.skip, true);
  assert.equal(pricing.kind, "AUTH_REQUIRED");
  const jina = mem.shouldSkip("https://r.jina.ai/https://www.virphoneusa.com/");
  assert.equal(jina.skip, true);
  assert.equal(jina.kind, "HOST_POLICY_BLOCKED");
});

test("a parallel batch keeps one fetch_url per host", () => {
  const { execute, skip } = firstFetchUrlPerHost([
    { name: "fetch_url", arguments: { url: "https://www.virphoneusa.com/" } },
    { name: "fetch_url", arguments: { url: "https://www.virphoneusa.com/pricing" } },
    { name: "fetch_url", arguments: { url: "https://www.virphoneusa.com/contact" } },
    { name: "fetch_url", arguments: { url: "https://r.jina.ai/https://www.virphoneusa.com/pricing" } },
    { name: "web_search", arguments: { query: "virphoneusa" } },
  ]);
  assert.equal(execute.filter((c) => c.name === "fetch_url").length, 1);
  assert.equal(execute.some((c) => c.name === "web_search"), true);
  assert.equal(skip.length, 3);
});

test("model recovery forbids retrying fetch and jina", () => {
  const note = modelFetchRecovery("virphoneusa.com", "AUTH_REQUIRED", false);
  assert.match(note, /Do not call fetch_url again/);
  assert.match(note, /r\.jina\.ai/);
  assert.match(note, /web_search/);
  assert.doesNotMatch(note, /OpenShell/);
});

test("user-facing 401 text is short", () => {
  assert.equal(userFacingFetchError("virphoneusa.com", "AUTH_REQUIRED"), "Could not read virphoneusa.com — the server required a login (401).");
});
