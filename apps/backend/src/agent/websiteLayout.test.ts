import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listExistingSiteFiles, planWebsiteLayout, siteWriteRefusal } from "./websiteLayout";

test("a new website keeps an existing site and is written beside it", () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-site-"));
  writeFileSync(join(root, "index.html"), "<h1>The Morning Mix</h1>");
  writeFileSync(join(root, "styles.css"), "h1{color:orange}");
  writeFileSync(join(root, "app.js"), "console.log(1)");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.html"), "<p>ignore</p>");

  const existing = listExistingSiteFiles(root);
  assert.deepEqual(existing, ["app.js", "index.html", "styles.css"]);
  const layout = planWebsiteLayout("build a simple website for virphone", existing);
  assert.equal(layout.directory, "sites/virphone");
  assert.deepEqual(layout.protectedFiles, existing);
  assert.match(layout.prompt, /must stay as they are/);
  assert.match(layout.prompt, /sites\/virphone/);

  assert.match(siteWriteRefusal(layout, "write_file", "index.html") ?? "", /already written/);
  assert.match(siteWriteRefusal(layout, "edit_file", "./styles.css") ?? "", /styles\.css/);
  assert.equal(siteWriteRefusal(layout, "write_file", "sites/virphone/index.html"), null);
  assert.equal(siteWriteRefusal(layout, "read_file", "index.html"), null);
});

test("an empty project still writes the site at the root", () => {
  const layout = planWebsiteLayout("build a simple website for virphone", []);
  assert.equal(layout.directory, null);
  assert.deepEqual(layout.protectedFiles, []);
  assert.match(layout.prompt, /Call write_file for index.html/);
  assert.equal(siteWriteRefusal(layout, "write_file", "index.html"), null);
});

test("an explicit replace may overwrite, and a taken folder gets the next name", () => {
  const replace = planWebsiteLayout("replace the website with a virphone site", ["index.html"]);
  assert.equal(replace.directory, null);
  assert.equal(siteWriteRefusal(replace, "write_file", "index.html"), null);

  const next = planWebsiteLayout("build a website for virphone", ["sites/virphone/index.html", "sites/virphone/styles.css"]);
  assert.equal(next.directory, "sites/virphone-2");
  assert.match(siteWriteRefusal(next, "delete_file", "sites/virphone/index.html") ?? "", /already written/);
});
