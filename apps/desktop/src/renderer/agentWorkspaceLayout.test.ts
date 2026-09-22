import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentPanelPlacement,
  countRightColumns,
  followActiveTab,
  nextWorkspaceLayout,
  simultaneousRightViews,
  visibleWorkspaceViews,
  workspaceMarkupContract,
} from "./agentWorkspaceLayout.ts";
import { followApplies, routeEvent, type WorkspaceEvent } from "./agentWorkspaceModel.ts";
import { parseDesktopLayout, persistableLayout, toAgentWorkspaceLayout } from "./desktopLayout.ts";

function ev(type: string, data: Record<string, unknown> = {}): WorkspaceEvent {
  return { id: type, type, timestamp: 1, data };
}

test("opening Agent Workspace always yields exactly one right column", () => {
  const open = parseDesktopLayout({ rightPanelOpen: true });
  assert.equal(open.rightPanelOpen, true);
  assert.equal(countRightColumns(open), 1);
  assert.equal(countRightColumns({ open: true }), 1);
  assert.equal(countRightColumns({ rightPanelOpen: false }), 0);
});

test("legacy inspectorOpen / pin / width cannot recreate a second column", () => {
  const legacy = parseDesktopLayout({
    rightPanelOpen: true,
    inspectorOpen: true,
    inspectorPinned: true,
    inspectorWidth: 340,
    inspectorTab: "review",
    surfaceTab: "changes",
    workSurfaceWidth: 560,
  });
  assert.equal(countRightColumns(legacy), 1);
  assert.equal(legacy.activeTab, "changes");
  const stored = persistableLayout(legacy);
  assert.equal("inspectorOpen" in stored, false);
  assert.equal("inspectorPinned" in stored, false);
  assert.equal("inspectorWidth" in stored, false);
  assert.equal("inspectorTab" in stored, false);
  assert.equal("workSurfaceWidth" in stored, false);
  assert.equal("surfaceTab" in stored, false);
  assert.equal(countRightColumns(parseDesktopLayout(stored)), 1);
});

test("Changes → Review switches the same panel tab, never a second column", () => {
  let layout = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "changes", followOrion: true },
    routeEvent(ev("run.completed"))
  );
  assert.equal(layout.activeTab, "review");
  assert.equal(layout.columns, 1);
  assert.deepEqual(visibleWorkspaceViews(layout.activeTab), ["review"]);
  const views = simultaneousRightViews(layout.activeTab);
  assert.equal(views.changes, false);
  assert.equal(views.review, true);
});

test("Preview → Diff stays one panel; Preview can be selected again", () => {
  const afterEdit = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "preview", followOrion: true },
    routeEvent(ev("file.edit", { preview: { path: "App.tsx" } }))
  );
  assert.equal(afterEdit.activeTab, "diff");
  assert.equal(afterEdit.columns, 1);
  const views = simultaneousRightViews(afterEdit.activeTab);
  assert.equal(views.preview, false);
  assert.equal(views.diff, true);
  assert.equal(followActiveTab(null, "preview"), "preview");
});

test("file click and terminal / browser events only switch the active tab", () => {
  const fromChanges = { open: true, width: 520, activeTab: "changes" as const, followOrion: true };
  assert.equal(nextWorkspaceLayout(fromChanges, routeEvent(ev("file.edit", { path: "App.tsx" }))).activeTab, "diff");
  assert.equal(nextWorkspaceLayout(fromChanges, routeEvent(ev("terminal.started", { command: "npm test" }))).activeTab, "terminal");
  assert.equal(
    nextWorkspaceLayout(fromChanges, routeEvent(ev("browser.action", { tool: "browser_click", url: "https://example.com" }))).activeTab,
    "browser"
  );
  assert.equal(
    nextWorkspaceLayout(fromChanges, routeEvent(ev("preview.available", { url: "http://127.0.0.1:5173" }))).activeTab,
    "preview"
  );
  assert.equal(nextWorkspaceLayout(fromChanges, routeEvent(ev("file.read", { path: "readme.md" }))).activeTab, "changes");
});

test("awaiting approval does not switch to Review and does not add a column", () => {
  const approval = routeEvent(ev("approval.required", { tool: "terminal" }));
  assert.equal(approval?.switchTab, false);
  const next = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "changes", followOrion: true },
    approval
  );
  assert.equal(next.activeTab, "changes");
  assert.equal(next.columns, 1);
  assert.notEqual(next.activeTab, "review");
});

test("Follow ORION paused or off never changes tab or panel count", () => {
  const edit = routeEvent(ev("file.edit", { path: "App.tsx" }));
  const paused = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "preview", followOrion: true, followPaused: true },
    edit
  );
  assert.equal(paused.activeTab, "preview");
  assert.equal(paused.columns, 1);
  const off = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "changes", followOrion: false },
    edit
  );
  assert.equal(off.activeTab, "changes");
  assert.equal(followApplies({ followOrion: true, paused: true }), false);
});

test("review.rejected may switch the same panel to Review", () => {
  const next = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "files", followOrion: true },
    routeEvent(ev("review.rejected"))
  );
  assert.equal(next.activeTab, "review");
  assert.equal(next.columns, 1);
});

test("narrow windows overlay the one panel instead of adding a column", () => {
  assert.equal(agentPanelPlacement(1920, true), "dock");
  assert.equal(agentPanelPlacement(1280, true), "dock");
  assert.equal(agentPanelPlacement(1000, true), "overlay");
  assert.equal(agentPanelPlacement(1920, false), "hidden");
  assert.equal(countRightColumns({ rightPanelOpen: true }), 1);
});

test("DOM contract: one agent-workbench, one tab bar, no inspector-panel", () => {
  const html = `<aside data-testid="agent-workbench" data-right-columns="1"><nav data-testid="agent-workbench-tabbar"></nav></aside>`;
  const contract = workspaceMarkupContract(html);
  assert.equal(contract.workspaces, 1);
  assert.equal(contract.tabbars, 1);
  assert.equal(contract.inspectors, 0);
  const twoPane = workspaceMarkupContract(
    `<div data-testid="agent-workbench"></div><div data-testid="inspector-panel"></div>`
  );
  assert.equal(twoPane.workspaces, 1);
  assert.equal(twoPane.inspectors, 1);
  assert.notEqual(twoPane.inspectors, 0);
});

test("desktop events switch the same Workbench tab", () => {
  const next = nextWorkspaceLayout(
    { open: true, width: 650, activeTab: "changes", followOrion: true },
    routeEvent(ev("desktop.ready", { url: "http://127.0.0.1:43191" }))
  );
  assert.equal(next.activeTab, "desktop");
  assert.equal(next.columns, 1);
  const paused = nextWorkspaceLayout(
    { open: true, width: 650, activeTab: "browser", followOrion: true, followPaused: true },
    routeEvent(ev("tool.started", { tool: "desktop_click" }))
  );
  assert.equal(paused.activeTab, "browser");
});

test("layout snapshot exposes a single AgentWorkspaceLayout", () => {
  const parsed = parseDesktopLayout({ rightPanelOpen: true, agentPanelWidth: 540, activeTab: "files" });
  assert.deepEqual(toAgentWorkspaceLayout(parsed), {
    open: true,
    width: 540,
    activeTab: "files",
    followOrion: true,
  });
});
