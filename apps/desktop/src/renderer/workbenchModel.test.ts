import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactTabId,
  assembleWorkbenchTabs,
  canonicalizeOpenTabIds,
  closeTab,
  diffTabId,
  fileTabId,
  followWorkbenchTab,
  nextTerminalTabId,
  parseWorkbenchTab,
  previewTabId,
  reconcileWorkbenchTabs,
  rememberUrl,
  resolveActiveWorkbenchTabId,
  truncateTabTitle,
  upsertTab,
  workbenchMarkupContract,
  workbenchTabCloseEffect,
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

test("closing the active tab selects the adjacent tab, never a second pane", () => {
  const tabs = reconcileWorkbenchTabs({
    openTabIds: ["browser", fileTabId("a.html"), fileTabId("b.html")],
    activeTabId: fileTabId("a.html"),
  }).tabs;
  assert.deepEqual(tabs.map((t) => t.id), ["browser", "file:a.html", "file:b.html"]);
  const middle = closeTab(tabs, "file:a.html", "file:a.html");
  assert.equal(middle.activeId, "browser");
  assert.deepEqual(middle.tabs.map((t) => t.id), ["browser", "file:b.html"]);
  const last = closeTab(tabs, "file:b.html", "file:b.html");
  assert.equal(last.activeId, "file:a.html");
  const first = closeTab(tabs, "browser", "browser");
  assert.equal(first.activeId, "file:a.html");
  assert.equal(first.tabs.some((t) => t.kind === "browser"), false);
});

test("Follow ORION maps events onto one workbench tab", () => {
  assert.equal(followWorkbenchTab("diff", { path: "App.tsx" }).id, "diff:App.tsx");
  const preview = followWorkbenchTab("preview", { url: "http://127.0.0.1:5173" });
  assert.equal(preview.kind, "preview");
  assert.equal(preview.id, previewTabId("http://127.0.0.1:5173"));
  assert.equal(preview.url, "http://127.0.0.1:5173");
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

test("any open workbench tab can be closed without opening a second pane", () => {
  const pinned = closeTab([parseWorkbenchTab("files")], "files", "files");
  assert.equal(pinned.tabs.length, 0);
  const next = closeTab([parseWorkbenchTab("files"), parseWorkbenchTab(fileTabId("src/App.tsx"))], fileTabId("src/App.tsx"), fileTabId("src/App.tsx"));
  assert.deepEqual(next.tabs.map((t) => t.id), ["files"]);
  assert.equal(next.activeId, "files");
  const preview = closeTab([parseWorkbenchTab(previewTabId("http://127.0.0.1:4693")), parseWorkbenchTab("desktop")], previewTabId("http://127.0.0.1:4693"), previewTabId("http://127.0.0.1:4693"));
  assert.deepEqual(preview.tabs.map((t) => t.id), ["desktop"]);
});

test("an empty Workbench has no tabs, and opened tools share one row", () => {
  assert.deepEqual(assembleWorkbenchTabs({ openTabIds: [], activeTabId: "" }), []);
  const tools = assembleWorkbenchTabs({
    openTabIds: ["files", "terminal", "browser", "changes"],
    activeTabId: "files",
  });
  assert.deepEqual(tools.map((t) => t.id), ["files", "changes", "terminal", "browser"]);
  assert.equal(new Set(tools.map((t) => t.kind)).size, 4);
  const withFiles = assembleWorkbenchTabs({
    openTabIds: ["files", fileTabId("index.html"), fileTabId("styles.css")],
    activeTabId: fileTabId("styles.css"),
  });
  assert.deepEqual(withFiles.map((t) => t.id), ["files", "file:index.html", "file:styles.css"]);
  assert.equal(withFiles.filter((t) => t.kind === "file").length, 2);
  assert.equal(resolveActiveWorkbenchTabId(withFiles, fileTabId("styles.css")), "file:styles.css");
  assert.equal(withFiles.filter((t) => t.kind === "file").every((t) => t.closable), true);
  assert.equal(withFiles.find((t) => t.id === "files")?.closable, true);
});

test("dynamic preview, diff, and browser pages stay on the same tab list", () => {
  const tabs = assembleWorkbenchTabs({
    openTabIds: ["changes", diffTabId("index.html"), previewTabId("http://127.0.0.1:43191"), "browser:page-1"],
    activeTabId: "changes",
    browserTabs: [{ id: "page-1", kind: "browser", title: "VirPhone Website", url: "https://virphone.example" }],
  });
  assert.deepEqual(tabs.map((t) => t.kind), ["changes", "preview", "browser", "diff"]);
  assert.equal(tabs.find((t) => t.kind === "browser")?.title, "VirPhone Website");
  assert.equal(tabs.filter((t) => t.id === "changes").length, 1);
});

test("browser navigated to the preview URL is one tab", () => {
  const url = "http://127.0.0.1:43191";
  const once = reconcileWorkbenchTabs({
    openTabIds: ["browser", "browser:tab1", previewTabId(url)],
    activeTabId: "browser:tab1",
    previewUrl: url,
    browserTabs: [{ id: "tab1", kind: "browser", title: "VirPhone Website", url: `${url}/` }],
  });
  assert.equal(once.tabs.length, 1);
  assert.equal(once.tabs[0]?.kind, "preview");
  assert.equal(once.activeId, previewTabId(url));
  assert.equal(once.tabs.filter((t) => t.kind === "browser").length, 0);
});

test("the same preview event twice does not duplicate a tab", () => {
  const url = "http://127.0.0.1:43191";
  const again = reconcileWorkbenchTabs({
    openTabIds: [previewTabId(url), previewTabId(`${url}/`), previewTabId(url)],
    activeTabId: previewTabId(`${url}/`),
    previewUrl: `${url}/`,
  });
  assert.equal(again.tabs.filter((t) => t.kind === "preview").length, 1);
  assert.equal(again.activeId, previewTabId(url));
});

test("opening index.html twice keeps one file tab", () => {
  const opened = reconcileWorkbenchTabs({
    openTabIds: [fileTabId("index.html"), fileTabId("./index.html"), fileTabId("index.html")],
    activeTabId: fileTabId("./index.html"),
  });
  assert.equal(opened.tabs.filter((t) => t.kind === "file").length, 1);
  assert.equal(opened.activeId, "file:index.html");
  assert.equal(opened.tabs[0]?.title, "index.html");
});

test("closing a view does not stop the server or kill the terminal", () => {
  const preview = workbenchTabCloseEffect(parseWorkbenchTab(previewTabId("http://127.0.0.1:43191")));
  const terminal = workbenchTabCloseEffect(parseWorkbenchTab("terminal"));
  const browser = workbenchTabCloseEffect(parseWorkbenchTab("browser:tab1"));
  assert.equal(preview.stopServer, false);
  assert.equal(preview.killTerminal, false);
  assert.equal(preview.closeNativeView, false);
  assert.equal(terminal.stopServer, false);
  assert.equal(terminal.killTerminal, false);
  assert.equal(terminal.closeNativeView, false);
  assert.equal(browser.stopServer, false);
  assert.equal(browser.killTerminal, false);
  assert.equal(browser.closeNativeView, true);
});

test("restored tab ids drop duplicates and keep tool order", () => {
  const ids = canonicalizeOpenTabIds([
    "browser:tab1",
    "browser",
    "environment",
    "desktop",
    previewTabId("http://127.0.0.1:43191/"),
    previewTabId("http://127.0.0.1:43191"),
    fileTabId("./index.html"),
    fileTabId("index.html"),
    "terminal",
    "files",
    "changes",
    diffTabId("index.html"),
  ]);
  assert.deepEqual(ids, [
    "desktop",
    "files",
    "changes",
    "terminal",
    "environment",
    previewTabId("http://127.0.0.1:43191"),
    "browser:tab1",
    "file:index.html",
    "diff:index.html",
  ]);
  assert.equal(resolveActiveWorkbenchTabId(ids.map((id) => parseWorkbenchTab(id)), "browser"), "browser:tab1");
});

test("DOM contract: one workbench, one tab bar, no inspector", () => {
  const html = `<aside data-testid="agent-workbench"><nav data-testid="agent-workbench-tabbar"></nav></aside>`;
  const c = workbenchMarkupContract(html);
  assert.equal(c.workbenches, 1);
  assert.equal(c.tabbars, 1);
  assert.equal(c.inspectors, 0);
});
