import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAddMenuItems,
  capabilityNote,
  composerTriggerKey,
  filterAddMenuItems,
  isSelected,
  moveHighlight,
  toggleSelected,
  type AddMenuSnapshot,
} from "./addMenuModel.ts";

function snap(over: Partial<AddMenuSnapshot> = {}): AddMenuSnapshot {
  return {
    workspaceRoot: "/proj",
    workspaceName: "proj",
    workspaceKind: "folder",
    localMode: true,
    cloudMode: false,
    openTabs: ["src/App.tsx"],
    recents: [],
    selection: { path: "src/App.tsx", startLine: 120, endLine: 184 },
    skills: [{ id: "debug", name: "Debugging", description: "Structured debugging workflow" }],
    plugins: [],
    mcp: [{ id: "gh", name: "GitHub MCP", state: "CONNECTED", toolCount: 4 }],
    sshHostCount: 0,
    githubConnected: false,
    browserAvailable: true,
    selectedIds: [],
    ...over,
  };
}

test("catalog uses real snapshot data and does not invent plugins", () => {
  const items = buildAddMenuItems(snap());
  assert.ok(items.some((i) => i.kind === "attachments"));
  assert.ok(items.some((i) => i.name === "Selected code" && /App\.tsx · lines 120–184/.test(i.description)));
  assert.ok(items.some((i) => i.name === "Debugging"));
  assert.ok(items.some((i) => i.name === "GitHub MCP"));
  assert.ok(items.some((i) => i.kind === "browser"));
  assert.equal(items.some((i) => i.name === "ZCode"), false);
  assert.equal(items.some((i) => /fake/i.test(i.name)), false);
});

test("empty skills and plugins stay honest", () => {
  const items = buildAddMenuItems(snap({ skills: [], plugins: [], mcp: [], workspaceRoot: null, workspaceKind: null }));
  assert.ok(items.some((i) => i.name === "No skills available"));
  assert.ok(items.some((i) => i.name === "No plugins installed"));
  assert.ok(items.some((i) => /Open a workspace/.test(i.name)));
});

test("cloud mode hides the local terminal capability", () => {
  const items = buildAddMenuItems(snap({ localMode: false, cloudMode: true }));
  assert.equal(items.some((i) => i.kind === "terminal" && i.section === "tools"), false);
});

test("search spans skills, plugins, files, and capabilities", () => {
  const items = buildAddMenuItems(snap());
  assert.ok(filterAddMenuItems(items, "debug").some((i) => i.name === "Debugging"));
  assert.ok(filterAddMenuItems(items, "github").some((i) => i.name === "GitHub MCP"));
  assert.ok(filterAddMenuItems(items, "App.tsx").some((i) => i.kind === "tab" || i.kind === "selection"));
  assert.ok(filterAddMenuItems(items, "browser").some((i) => i.kind === "browser"));
});

test("keyboard highlight wraps and duplicate selection toggles", () => {
  assert.equal(moveHighlight(0, -1, 3), 2);
  assert.equal(moveHighlight(2, 1, 3), 0);
  assert.deepEqual(toggleSelected(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleSelected(["a", "b"], "a"), ["b"]);
  assert.equal(isSelected(["ctx:tab:App.tsx"], "ctx:tab:App.tsx"), true);
});

test("composer trigger keys open context, capabilities, and skills", () => {
  assert.equal(composerTriggerKey("@"), "context");
  assert.equal(composerTriggerKey("/"), "capabilities");
  assert.equal(composerTriggerKey("$"), "skills");
  assert.equal(composerTriggerKey("a"), null);
});

test("capability note is a single stream line, not one event per chip", () => {
  const note = capabilityNote([
    { id: "ctx:tab:App.tsx", section: "context", kind: "tab", name: "App.tsx", description: "" },
    { id: "cap:browser", section: "tools", kind: "browser", name: "Browser", description: "" },
  ]);
  assert.equal(note, "Added context · App.tsx + Browser");
});
