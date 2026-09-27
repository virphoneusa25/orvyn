import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "http";
import express from "express";
import { applySiteEdit, composeSiteDocument, hasSiteFile, PREVIEW_CACHE_CONTROL, publishAgentSite, publishRememberedSite, readPublishedFile, rememberSiteBinary, rememberSiteFile } from "./sitePreview";
import { siteRouter } from "../routes/sites";

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
  assert.equal(again?.unchanged, true);
  assert.equal(again?.revision, site!.revision);
});

test("html, css, and a repair share one preview and increasing revisions", () => {
  const runId = "run-progressive";
  const first = publishRememberedSite(runId, ["index.html"]);
  assert.equal(first, null);
  rememberSiteFile(runId, "index.html", "<html><head></head><body><h1>Shell</h1></body></html>");
  const opened = publishRememberedSite(runId, ["index.html"])!;
  assert.equal(opened.first, true);
  assert.equal(opened.revision, 1);
  rememberSiteFile(runId, "styles.css", "h1{color:white}");
  const styled = publishRememberedSite(runId, ["styles.css"])!;
  assert.equal(styled.url, opened.url);
  assert.equal(styled.first, false);
  assert.equal(styled.revision, 2);
  assert.deepEqual(styled.changedFiles, ["styles.css"]);
  assert.equal(readPublishedFile(styled.id, "styles.css")?.contentType, "text/css; charset=utf-8");
  rememberSiteFile(runId, "index.html", "<html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><h1>Shell</h1><section id=\"services\">Routes</section></body></html>");
  const section = publishRememberedSite(runId, ["index.html"])!;
  assert.equal(section.url, opened.url);
  assert.equal(section.revision, 3);
  assert.match(readPublishedFile(section.id, "index.html")?.body.toString() ?? "", /services/);
});

test("a nested page loads root-relative css from the same preview", () => {
  const runId = "run-nested";
  rememberSiteFile(runId, "sites/carrier/index.html", `<html><head><link rel="stylesheet" href="/styles.css"></head><body><h1>Carrier</h1></body></html>`);
  rememberSiteFile(runId, "sites/carrier/styles.css", "h1 { color: navy; }");
  const published = publishRememberedSite(runId, ["sites/carrier/index.html", "sites/carrier/styles.css"])!;
  const page = readPublishedFile(published.id, "index.html")!.body.toString();
  assert.match(page, /href="styles\.css"/);
  assert.doesNotMatch(page, /href="\/styles\.css"/);
  assert.equal(readPublishedFile(published.id, "styles.css")?.contentType, "text/css; charset=utf-8");
  assert.match(readPublishedFile(published.id, "styles.css")?.body.toString() ?? "", /navy/);
});

test("preview responses send the newest css and do not cache it", async () => {
  const runId = "run-http";
  rememberSiteFile(runId, "index.html", `<html><head><link rel="stylesheet" href="/styles.css"></head><body><h1>Live</h1></body></html>`);
  rememberSiteFile(runId, "styles.css", "h1 { color: red; }");
  const published = publishRememberedSite(runId, ["index.html", "styles.css"])!;
  const app = express();
  app.use("/api/v1/sites", siteRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const css = await fetch(`http://127.0.0.1:${port}/api/v1/sites/${published.id}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.equal(css.headers.get("cache-control"), PREVIEW_CACHE_CONTROL);
    assert.match(await css.text(), /red/);
    const page = await fetch(`http://127.0.0.1:${port}/api/v1/sites/${published.id}/`);
    assert.match(await page.text(), /href="styles\.css"/);
    rememberSiteFile(runId, "styles.css", "h1 { color: blue; }");
    const next = publishRememberedSite(runId, ["styles.css"])!;
    assert.equal(next.url, published.url);
    const updated = await fetch(`http://127.0.0.1:${port}/api/v1/sites/${published.id}/styles.css`);
    assert.match(await updated.text(), /blue/);
    assert.equal(updated.headers.get("cache-control"), PREVIEW_CACHE_CONTROL);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a generated project image is served beside the published page", () => {
  const runId = "run-binary-hero";
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  rememberSiteFile(runId, "index.html", '<style>main{background:url("public/hero.png")}</style><main>Site</main>');
  rememberSiteBinary(runId, "public/hero.png", png);
  const published = publishRememberedSite(runId)!;
  assert.ok(published.files.includes("public/hero.png"));
  assert.deepEqual(readPublishedFile(published.id, "public/hero.png")?.body, png);
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

test("a stylesheet linked as /styles.css loads in the preview (served under /sites/<id>/)", () => {
  const runId = "run-root-ref";
  rememberSiteFile(runId, "index.html", `<html><head><link rel="stylesheet" href="/styles.css"></head><body><h1>Radio</h1><script src="/app.js"></script></body></html>`);
  rememberSiteFile(runId, "styles.css", "h1 { color: orange; }");
  rememberSiteFile(runId, "app.js", "console.log(1);");
  const published = publishRememberedSite(runId)!;
  const page = readPublishedFile(published.id, "index.html")!.body.toString();
  assert.match(page, /href="styles\.css"/);
  assert.match(page, /src="app\.js"/);
  assert.equal(readPublishedFile(published.id, "styles.css")?.body.toString(), "h1 { color: orange; }");
});

test("an edit to the stylesheet reaches the preview", () => {
  const runId = "run-edit";
  rememberSiteFile(runId, "index.html", `<link rel="stylesheet" href="style.css"><h1>x</h1>`);
  rememberSiteFile(runId, "style.css", "h1 { color: red; }");
  assert.equal(applySiteEdit(runId, "style.css", "red", "blue"), true);
  assert.equal(applySiteEdit(runId, "style.css", "missing text", "x"), false);
  assert.equal(applySiteEdit(runId, "other.css", "a", "b"), false);
  const published = publishRememberedSite(runId)!;
  assert.equal(readPublishedFile(published.id, "style.css")?.body.toString(), "h1 { color: blue; }");
  assert.equal(hasSiteFile(runId, "style.css"), true);
});
