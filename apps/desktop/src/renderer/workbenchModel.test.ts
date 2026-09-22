import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeTab,
  diffTabId,
  fileTabId,
  followWorkbenchTab,
  parseWorkbenchTab,
  previewTabId,
  rememberUrl,
  truncateTabTitle,
  upsertTab,
  workbenchMarkupContract,
} from "./workbenchModel.ts";

test("dynamic preview and file tabs are closable and unique", () => {
  const preview = parseWorkbenchTab(previewTabId("http://127.0.0.1:43191"));
  assert.equal(preview.kind, "preview");
  assert.equal(preview.closable, true);
  assert.match(preview.title, /43191/);
  const file = parseWorkbenchTab(fileTabId("src/App.tsx"));
  assert.equal(file.title, "App.tsx");
  const tabs = upsertTab(upsertTab([parseWorkbenchTab("changes")], preview), preview);
  assert.equal(tabs.length, 2);
});

test("closing the active tab selects a neighbor, never a second pane", () => {
  const tabs = [
    parseWorkbenchTab("changes"),
    parseWorkbenchTab(diffTabId("App.tsx")),
    parseWorkbenchTab("browser"),
  ];
  const next = closeTab(tabs, diffTabId("App.tsx"), diffTabId("App.tsx"));
  assert.equal(next.tabs.length, 2);
  assert.equal(next.activeId, "changes");
  assert.equal(next.tabs.filter((t) => t.kind === "diff").length, 0);
});

test("Follow ORION maps events onto one workbench tab", () => {
  assert.equal(followWorkbenchTab("diff", { path: "App.tsx" }).id, "diff:App.tsx");
  assert.equal(followWorkbenchTab("preview", { url: "http://127.0.0.1:5173" }).kind, "preview");
  assert.equal(followWorkbenchTab("browser", { browserId: "b1" }).id, "browser:b1");
  assert.equal(followWorkbenchTab("desktop").id, "desktop");
  assert.equal(followWorkbenchTab("terminal").id, "terminal");
  assert.equal(followWorkbenchTab("review").id, "review");
});

test("browser session tabs are closable and titled from the page", () => {
  const tab = parseWorkbenchTab("browser:abc");
  assert.equal(tab.kind, "browser");
  assert.equal(tab.closable, true);
  assert.equal(tab.id, "browser:abc");
  assert.equal(truncateTabTitle("Global Voice & Telecom Infrastructure | VirPhone USA"), "Global Voice & Telecom Infr…");
});

test("recent URLs are real, newest first, no duplicates", () => {
  const recents = rememberUrl(rememberUrl(["http://a"], "http://b"), "http://a");
  assert.deepEqual(recents, ["http://a", "http://b"]);
  assert.deepEqual(rememberUrl([], "javascript:alert(1)"), []);
});

test("DOM contract: one workbench, one tab bar, no inspector", () => {
  const html = `<aside data-testid="agent-workbench"><nav data-testid="agent-workbench-tabbar"></nav></aside>`;
  const c = workbenchMarkupContract(html);
  assert.equal(c.workbenches, 1);
  assert.equal(c.tabbars, 1);
  assert.equal(c.inspectors, 0);
});
