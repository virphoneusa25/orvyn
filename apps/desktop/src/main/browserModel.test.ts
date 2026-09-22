import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampBrowserBounds,
  guestSecurityPrefs,
  isSafeBrowserUrl,
  looksLikeUrlOrDomain,
  normalizeBrowserInput,
  parseBrowserWorkbenchId,
  previewWorkbenchTitle,
  rememberBrowserRecent,
  requestBrowserControl,
  truncateTabTitle,
  type BrowserTab,
} from "./browserModel.ts";

test("URL normalization: domains, localhost, and blocked schemes", () => {
  assert.deepEqual(normalizeBrowserInput("virphoneusa.com"), { ok: true, url: "https://virphoneusa.com" });
  assert.deepEqual(normalizeBrowserInput("https://virphoneusa.com"), { ok: true, url: "https://virphoneusa.com" });
  assert.deepEqual(normalizeBrowserInput("127.0.0.1:5173"), { ok: true, url: "http://127.0.0.1:5173" });
  assert.deepEqual(normalizeBrowserInput("localhost:43191/"), { ok: true, url: "http://localhost:43191/" });
  assert.equal(normalizeBrowserInput("javascript:alert(1)").ok, false);
  assert.equal(normalizeBrowserInput("data:text/html,hi").ok, false);
  assert.equal(normalizeBrowserInput("file:///etc/passwd").ok, false);
  const search = normalizeBrowserInput("best voip providers");
  assert.equal(search.ok, false);
  if (!search.ok) assert.equal(search.search, "best voip providers");
});

test("safe protocols reject javascript and data", () => {
  assert.equal(isSafeBrowserUrl("https://www.virphoneusa.com/"), true);
  assert.equal(isSafeBrowserUrl("http://127.0.0.1:43191"), true);
  assert.equal(isSafeBrowserUrl("javascript:alert(1)"), false);
  assert.equal(looksLikeUrlOrDomain("virphoneusa.com"), true);
  assert.equal(looksLikeUrlOrDomain("what is sip"), false);
});

test("recents are newest first, unique, and drop unsafe URLs", () => {
  const a = rememberBrowserRecent([], { url: "https://a.example", title: "A", lastVisitedAt: 1 });
  const b = rememberBrowserRecent(a, { url: "https://b.example", title: "B", lastVisitedAt: 2 });
  const c = rememberBrowserRecent(b, { url: "https://a.example", title: "A again", lastVisitedAt: 3 });
  assert.equal(c[0]!.url, "https://a.example");
  assert.equal(c.length, 2);
  assert.deepEqual(rememberBrowserRecent(c, { url: "javascript:alert(1)", title: "x", lastVisitedAt: 4 }), c);
});

test("tab ids and titles", () => {
  assert.deepEqual(parseBrowserWorkbenchId("browser:abc"), { kind: "browser", sessionId: "abc" });
  assert.deepEqual(parseBrowserWorkbenchId("preview:http://127.0.0.1:1"), { kind: "preview", sessionId: "http://127.0.0.1:1" });
  assert.equal(truncateTabTitle("Global Voice & Telecom Infrastructure | VirPhone USA"), "Global Voice & Telecom Infr…");
  assert.equal(previewWorkbenchTitle("http://127.0.0.1:43191", "ORVYN"), "ORVYN :43191");
  assert.equal(previewWorkbenchTitle("http://127.0.0.1:5173", "PawMart"), "PawMart :5173");
});

test("bounds reject tiny or non-finite rectangles", () => {
  assert.equal(clampBrowserBounds({ x: 10, y: 20, width: 40, height: 400 }), null);
  assert.deepEqual(clampBrowserBounds({ x: 420, y: 80, width: 650, height: 700 }), { x: 420, y: 80, width: 650, height: 700 });
});

test("guest pages never get Node or a preload", () => {
  const prefs = guestSecurityPrefs();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.preload, undefined);
});

test("control ownership is exclusive", () => {
  const tab = { controlOwner: "orion" } as BrowserTab;
  assert.equal(requestBrowserControl(tab, "user").ok, true);
  assert.equal(tab.controlOwner, "user");
  assert.equal(requestBrowserControl(tab, "orion").ok, true);
  assert.equal(tab.controlOwner, "orion");
});
