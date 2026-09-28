import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  validateNavigationUrl,
  resolveNavigationTarget,
  invalidPreviewUrlResult,
  setActivePreviewTarget,
  getActivePreviewTarget,
  notePreviewTargetStatus,
  forgetPreviewTarget,
  healthCheckPreviewUrl,
  isErrorPageTitle,
} from "./previewTarget";

// ── Relative path rejection ──────────────────────────────────────────────────

test("relative targets are rejected as INVALID_PREVIEW_URL", () => {
  for (const bad of ["index.html", "styles.css", "./site/index.html", "site/x.html", ""]) {
    const check = validateNavigationUrl(bad);
    assert.equal(check.ok, false, `"${bad}" must be rejected`);
    assert.equal(check.ok ? null : check.issue.code, "INVALID_PREVIEW_URL");
    assert.equal(check.ok ? null : check.issue.target, bad);
  }
});

test("absolute http(s) URLs pass; localhost and file: need explicit opt-in", () => {
  assert.deepEqual(validateNavigationUrl("https://orvyn.virphoneusa.com/api/v1/sites/abc/"), { ok: true, url: "https://orvyn.virphoneusa.com/api/v1/sites/abc/" });
  // A bare domain is host shorthand, not a file name: normalized to https.
  assert.deepEqual(validateNavigationUrl("example.com"), { ok: true, url: "https://example.com/" });
  assert.equal(validateNavigationUrl("http://localhost:3000/").ok, false);
  assert.equal(validateNavigationUrl("localhost").ok, false);
  assert.equal(validateNavigationUrl("http://localhost:3000/", { allowLocalhost: true }).ok, true);
  assert.equal(validateNavigationUrl("file:///tmp/x.html").ok, false);
  assert.equal(validateNavigationUrl("file:///tmp/x.html", { allowFile: true }).ok, true);
});

// ── Canonical URL propagation ────────────────────────────────────────────────

test("one canonical preview URL reaches every navigation consumer", () => {
  const runId = "run-canonical-propagation";
  const canonical = "https://orvyn.virphoneusa.com/api/v1/sites/0123-abcd/";
  // What publishSitePreview persists when the preview publishes — the same
  // value preview.available carries to the Preview pane.
  setActivePreviewTarget(runId, { siteId: "0123-abcd", url: canonical, revision: 1, status: "ready" });
  // The browser tool and the computer-use desktop guard both resolve through
  // resolveNavigationTarget: a file name is redirected to the canonical URL.
  const browser = resolveNavigationTarget(runId, "index.html");
  const desktop = resolveNavigationTarget(runId, "index.html");
  assert.equal(browser.ok, true);
  assert.equal(desktop.ok, true);
  if (browser.ok && desktop.ok) {
    assert.equal(browser.url, canonical);
    assert.equal(desktop.url, canonical);
    assert.equal(browser.redirectedFrom, "index.html");
  }
  // The registry answer and the event payload answer are the same URL.
  assert.equal(getActivePreviewTarget(runId)?.url, canonical);
  forgetPreviewTarget(runId);
});

test("no published preview → structured failure, never a guessed target", () => {
  const resolution = resolveNavigationTarget("run-no-preview", "index.html");
  assert.equal(resolution.ok, false);
  if (resolution.ok) return;
  const result = invalidPreviewUrlResult(resolution);
  assert.equal(result.ok, false);
  assert.match(result.error, /INVALID_PREVIEW_URL/);
  assert.match(result.error, /index\.html/);
  assert.deepEqual(result.meta, { code: "INVALID_PREVIEW_URL", target: "index.html", reason: "NOT_ABSOLUTE" });
});

// ── Preview readiness / health check ─────────────────────────────────────────

test("health check accepts 200 HTML and rejects 404 / wrong content type", async () => {
  const okServer = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<html><body>Hello page</body></html>"); });
  const badStatus = createServer((req, res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("nope"); });
  const badType = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await Promise.all([okServer.listen(0), badStatus.listen(0), badType.listen(0)]);
  const url = (s: typeof okServer) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
  try {
    assert.equal((await healthCheckPreviewUrl(url(okServer), 2000)).ok, true);
    assert.equal((await healthCheckPreviewUrl(url(badStatus), 2000)).ok, false);
    assert.equal((await healthCheckPreviewUrl(url(badType), 2000)).ok, false);
    // The health check itself allows localhost: it runs on the engine that
    // serves the preview. The NAVIGATION guard is what rejects loopback for
    // remote consumers.
    assert.equal((await healthCheckPreviewUrl("http://127.0.0.1:1/nope", 500)).ok, false);
  } finally {
    await Promise.all([okServer, badStatus, badType].map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
});

test("preview target status tracks verification outcomes", () => {
  const runId = "run-status-track";
  setActivePreviewTarget(runId, { siteId: "s1", url: "https://x.example/", revision: 1, status: "starting" });
  notePreviewTargetStatus(runId, "ready");
  assert.equal(getActivePreviewTarget(runId)?.status, "ready");
  notePreviewTargetStatus(runId, "failed");
  assert.equal(getActivePreviewTarget(runId)?.status, "failed");
  forgetPreviewTarget(runId);
  assert.equal(getActivePreviewTarget(runId), undefined);
});

// ── Error page detection ─────────────────────────────────────────────────────

test("browser error page titles are detected, real pages are not", () => {
  for (const bad of [
    "Server Not Found",
    "Page loading error — Server Not Found — Mozilla Firefox",
    "This site can't be reached",
    "Problem loading page",
    "Welcome to 404 Not Found",
    "ERR_CONNECTION_REFUSED",
    "ERR_NAME_NOT_RESOLVED",
  ]) {
    assert.equal(isErrorPageTitle(bad), true, `"${bad}" must be an error page`);
  }
  for (const good of ["Virphone — Home", "ORVYN Dashboard", "My Portfolio — About"]) {
    assert.equal(isErrorPageTitle(good), false, `"${good}" is a real page`);
  }
});
