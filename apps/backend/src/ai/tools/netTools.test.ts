import { test } from "node:test";
import assert from "node:assert/strict";
import { browserFetchHeaders, htmlToText, isBlockedHost, looksLikeWafBlock } from "./netTools";

test("fetch headers look like a desktop Chrome document request, not ORVYN-Agent", () => {
  const h = browserFetchHeaders();
  assert.match(h["User-Agent"] ?? "", /Chrome\/\d+/);
  assert.equal(h["Sec-Fetch-Mode"], "navigate");
  assert.doesNotMatch(h["User-Agent"] ?? "", /ORVYN-Agent/);
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
