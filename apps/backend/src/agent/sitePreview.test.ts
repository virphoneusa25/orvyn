import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { publishAgentSite, readPublishedFile } from "./sitePreview";

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
