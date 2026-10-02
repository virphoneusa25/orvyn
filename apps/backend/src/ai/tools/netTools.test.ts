import { test } from "node:test";
import assert from "node:assert/strict";
import { browserFetchHeaders, fetchHostKey, htmlToText, isBlockedHost, looksLikeWafBlock, normalizePublicHttpUrl } from "./netTools";

test("fetch headers look like a desktop Chrome request, not ORVYN-Agent", () => {
  const h = browserFetchHeaders();
  assert.match(h["User-Agent"] ?? "", /Chrome\/\d+/);
  assert.equal(h["Sec-Fetch-Mode"], undefined);
  assert.doesNotMatch(h["User-Agent"] ?? "", /ORVYN-Agent/);
});

test("bare domains become https URLs so fetch_url('virphoneusa.com') is valid", () => {
  const n = normalizePublicHttpUrl("virphoneusa.com");
  assert.equal(n.ok, true);
  if (n.ok) {
    assert.equal(n.url.protocol, "https:");
    assert.equal(n.url.hostname, "virphoneusa.com");
  }
  const read = normalizePublicHttpUrl("Read virphoneusa.com");
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.url.hostname, "virphoneusa.com");
  const site = normalizePublicHttpUrl("site:www.virphoneusa.com");
  assert.equal(site.ok, true);
  if (site.ok) assert.equal(site.url.hostname, "www.virphoneusa.com");
  const md = normalizePublicHttpUrl("[VirPhone](https://www.virphoneusa.com/about)");
  assert.equal(md.ok, true);
  if (md.ok) {
    assert.equal(md.url.hostname, "www.virphoneusa.com");
    assert.equal(md.url.pathname, "/about");
  }
  assert.equal(fetchHostKey("https://www.virphoneusa.com/about"), "virphoneusa.com");
  assert.equal(fetchHostKey("virphoneusa.com"), "virphoneusa.com");
  assert.equal(normalizePublicHttpUrl("not a url!!!").ok, false);
});

test("private hosts stay blocked", () => {
  assert.equal(isBlockedHost("127.0.0.1"), true);
  assert.equal(isBlockedHost("10.0.0.8"), true);
  assert.equal(isBlockedHost("virphoneusa.com"), false);
});

test("WAF 403 and Cloudflare challenge HTML are treated as blocks", () => {
  assert.equal(looksLikeWafBlock(403, "<html>denied</html>"), true);
  assert.equal(looksLikeWafBlock(200, "<title>Just a moment...</title> cf-browser-validation"), true);
  assert.equal(looksLikeWafBlock(200, "<html><h1>Get started</h1></html>", "text/html"), false);
});

test("htmlToText still strips scripts", () => {
  assert.equal(htmlToText("<p>Hi</p><script>alert(1)</script>"), "Hi");
});
