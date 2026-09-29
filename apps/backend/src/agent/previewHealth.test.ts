// The Preview is green only when the page AND its stylesheets, scripts and
// images are served. A missing stylesheet is DEGRADED (the raw-HTML preview).
import { test } from "node:test";
import assert from "node:assert/strict";
import { publishedSiteHealth } from "./previewCheck";
import { rebaseRootUrls } from "./sitePreview";

const HTML = '<!doctype html><html><head><title>NetGlobal</title><link rel="stylesheet" href="styles.css"></head><body><h1>We own the routes</h1><img src="/assets/globe.svg"><script src="script.js"></script></body></html>';
const files = (present: Record<string, string>) => (id: string, rel: string) => {
  const types: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
  const body = present[rel];
  return body === undefined ? undefined : { body: Buffer.from(body), contentType: types[rel.split(".").pop()!]! };
};

test("all assets served → READY", async () => {
  const h = await publishedSiteHealth("abc", files({ "index.html": HTML, "styles.css": "body{background:#070b14;color:#fff}", "script.js": "1", "assets/globe.svg": "<svg/>" }), rebaseRootUrls);
  assert.equal(h.status, "READY", JSON.stringify(h));
  assert.deepEqual(h.assets.map((a) => [a.path, a.status]).sort(), [["assets/globe.svg", 200], ["script.js", 200], ["styles.css", 200]]);
});

test("stylesheet missing → DEGRADED with the file named, never READY", async () => {
  const h = await publishedSiteHealth("abc", files({ "index.html": HTML, "script.js": "1", "assets/globe.svg": "<svg/>" }), rebaseRootUrls);
  assert.equal(h.status, "DEGRADED");
  assert.ok(h.issues.some((i) => /styles\.css → 404/.test(i)), JSON.stringify(h.issues));
});

test("root-absolute image resolves inside the site; a missing image is DEGRADED", async () => {
  const h = await publishedSiteHealth("abc", files({ "index.html": HTML, "styles.css": "body{color:red}", "script.js": "1" }), rebaseRootUrls);
  assert.equal(h.status, "DEGRADED");
  assert.ok(h.issues.some((i) => /globe\.svg → 404/.test(i)), JSON.stringify(h.issues));
});

test("no page → FAILED", async () => {
  const h = await publishedSiteHealth("abc", files({}), rebaseRootUrls);
  assert.equal(h.status, "FAILED");
});
