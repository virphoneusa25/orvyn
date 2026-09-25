import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composeSiteDocument, publishAgentSite, publishRememberedSite, readPublishedFile, rememberSiteFile } from "./sitePreview";

test("a preview is only the directory the agent wrote", () => {
  const empty = mkdtempSync(join(tmpdir(), "orvyn-empty-"));
  assert.equal(publishAgentSite(empty), null);
  const dir = mkdtempSync(join(tmpdir(), "orvyn-site-"));
  mkdirSync(join(dir, "css"));
  writeFileSync(join(dir, "index.html"), "<h1>from the agent</h1>");
  writeFileSync(join(dir, "css", "site.css"), "body{}");
  const published = publishAgentSite(dir);
  assert.ok(published);
  const page = readPublishedFile(published!.id, "index.html");
  assert.equal(page?.body.toString(), "<h1>from the agent</h1>");
  assert.equal(readPublishedFile(published!.id, "../secret.txt"), undefined);
});

test("the preview document includes the stylesheet and script", () => {
  rememberSiteFile("run-styled", "index.html", "<html><head></head><body><h1>Site</h1></body></html>");
  rememberSiteFile("run-styled", "styles.css", "h1{color:white}");
  rememberSiteFile("run-styled", "script.js", "console.log(1)");
  const html = composeSiteDocument("run-styled");
  assert.ok(html);
  assert.match(html!, /h1\{color:white\}/);
  assert.match(html!, /console\.log\(1\)/);
});

test("remembered pages publish without reading the project disk", () => {
  rememberSiteFile("run-1", "index.html", "<h1>agent</h1>");
  rememberSiteFile("run-1", "styles.css", "body{}");
  const site = publishRememberedSite("run-1");
  assert.ok(site);
  assert.match(site!.url, /\/api\/v1\/sites\//);
  assert.deepEqual(site!.files.sort(), ["index.html", "styles.css"]);
  assert.match(readPublishedFile(site!.id, "index.html")?.body.toString() ?? "", /body\{\}/);
  assert.equal(readPublishedFile(site!.id, "styles.css")?.contentType, "text/css; charset=utf-8");
  const again = publishRememberedSite("run-1");
  assert.equal(again?.url, site!.url);
});

test("a fixed script replaces the broken one in the preview (the page is never rewritten in place)", () => {
  const page = '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>x</h1><script src="app.js"></script></body></html>';
  rememberSiteFile("run-fix", "index.html", page);
  rememberSiteFile("run-fix", "app.js", "document.title = 'a';\nfunction broken( {\n");
  const first = publishRememberedSite("run-fix")!;
  assert.equal(readPublishedFile(first.id, "index.html")?.body.toString(), page, "loaded files are served as files, not inlined");
  rememberSiteFile("run-fix", "app.js", "document.title = 'a';\nfunction fixed() {}\n");
  rememberSiteFile("run-fix", "style.css", "h1{color:red}");
  const second = publishRememberedSite("run-fix")!;
  assert.equal(second.url, first.url);
  assert.match(readPublishedFile(second.id, "app.js")?.body.toString() ?? "", /fixed/);
  assert.doesNotMatch(readPublishedFile(second.id, "index.html")?.body.toString() ?? "", /broken/);
  assert.equal(readPublishedFile(second.id, "style.css")?.body.toString(), "h1{color:red}");
});
