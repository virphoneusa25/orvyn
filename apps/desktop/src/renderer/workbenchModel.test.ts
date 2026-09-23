import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactTabId,
  closeTab,
  diffTabId,
  fileTabId,
  followWorkbenchTab,
  nextTerminalTabId,
  parseWorkbenchTab,
  previewTabId,
  rememberUrl,
  truncateTabTitle,
  upsertTab,
  workbenchMarkupContract,
  WORKBENCH_LAUNCHERS,
  WORKBENCH_PLUS_ITEMS,
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

test("plus menu lists supported surfaces and launcher has four cards", () => {
  assert.deepEqual(WORKBENCH_LAUNCHERS.map((l) => l.label), ["Changes", "Browser", "Terminal", "Files"]);
  assert.deepEqual(WORKBENCH_PLUS_ITEMS.map((i) => i.label), [
    "File",
    "Terminal",
    "Browser",
    "Changes",
    "Desktop",
    "Environment",
    "Review",
    "Subscriptions",
    "New Side Chat",
  ]);
  assert.equal(WORKBENCH_PLUS_ITEMS.find((i) => i.id === "subscriptions")?.disabled, true);
  assert.equal(nextTerminalTabId([]), "terminal");
  assert.equal(nextTerminalTabId([parseWorkbenchTab("terminal")]), "terminal:2");
});

test("artifact tabs carry ArtifactService identity, not a generated/ path", () => {
  const tab = parseWorkbenchTab(artifactTabId("virphone-logo-2.png", "art_logo2"));
  assert.equal(tab.kind, "artifact");
  assert.equal(tab.artifactId, "art_logo2");
  assert.equal(tab.title, "virphone-logo-2.png");
  assert.doesNotMatch(tab.id, /generated\//);
  assert.equal(followWorkbenchTab("artifact", { name: "virphone-logo-2.png", artifactId: "art_logo2" }).artifactId, "art_logo2");
});

test("closing the last tab returns the empty launcher state", () => {
  const next = closeTab([parseWorkbenchTab("files")], "files", "files");
  assert.deepEqual(next.tabs, []);
  assert.equal(next.activeId, "");
});

test("DOM contract: one workbench, one tab bar, no inspector", () => {
  const html = `<aside data-testid="agent-workbench"><nav data-testid="agent-workbench-tabbar"></nav></aside>`;
  const c = workbenchMarkupContract(html);
  assert.equal(c.workbenches, 1);
  assert.equal(c.tabbars, 1);
  assert.equal(c.inspectors, 0);
});
