import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PANEL_DEFAULT,
  AGENT_PANEL_MIN,
  appGridTemplateColumns,
  clampAgentPanelWidth,
  clampTerminalHeight,
  parseDesktopLayout,
  persistableLayout,
  shouldOverlayAgentPanel,
  workbenchAllowedForView,
  SIDEBAR_WIDTH,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
} from "./desktopLayout.ts";

test("an explicit true preference means the right panel should show", () => {
  assert.equal(parseDesktopLayout({ rightPanelOpen: true }).rightPanelOpen, true);
});

test("right panel / terminal / help parse with safe defaults", () => {
  const empty = parseDesktopLayout(null);
  assert.equal(empty.rightPanelOpen, true);
  assert.equal(empty.bottomTerminalOpen, false);
  assert.equal(empty.helpOpen, false);
  assert.equal(empty.bottomTerminalHeight, TERMINAL_DEFAULT_HEIGHT);
  assert.equal(empty.activeTab, "changes");
  assert.deepEqual(empty.openTabIds, []);
  assert.equal(empty.activeTabId, "");
  assert.equal(empty.agentPanelWidth, AGENT_PANEL_DEFAULT);
  assert.equal(empty.followOrion, true);

  const parsed = parseDesktopLayout({
    rightPanelOpen: false,
    bottomTerminalOpen: true,
    bottomTerminalHeight: 300,
    helpOpen: true,
  });
  assert.equal(parsed.rightPanelOpen, false);
  assert.equal(parsed.bottomTerminalOpen, true);
  assert.equal(parsed.helpOpen, true);
  assert.equal(parsed.bottomTerminalHeight, 300);
});

test("terminal height is clamped so it cannot cover the app", () => {
  assert.equal(clampTerminalHeight(40), TERMINAL_MIN_HEIGHT);
  assert.ok(clampTerminalHeight(4000, 800) <= 360);
  assert.equal(clampTerminalHeight(Number.NaN), TERMINAL_DEFAULT_HEIGHT);
});

test("persistence omits ephemeral help and never writes inspector keys", () => {
  const stored = persistableLayout({
    rightPanelOpen: false,
    bottomTerminalOpen: true,
    bottomTerminalHeight: 260,
    helpOpen: true,
    agentPanelWidth: 520,
    activeTab: "changes",
    activeTabId: "changes",
    openTabIds: ["changes", "browser"],
    previewUrl: "",
    browserUrl: "",
    recentUrls: [],
    followOrion: true,
    expandedPreview: false,
  });
  assert.equal("helpOpen" in stored, false);
  assert.equal(stored.rightPanelOpen, false);
  assert.equal(stored.bottomTerminalOpen, true);
  assert.equal(stored.bottomTerminalHeight, 260);
  assert.equal(stored.agentPanelWidth, 520);
  assert.equal(stored.activeTab, "changes");
  assert.equal(stored.followOrion, true);
  assert.equal("inspectorOpen" in stored, false);
  assert.equal("inspectorWidth" in stored, false);
  assert.equal("workSurfaceWidth" in stored, false);
});

test("workbench width clamps to min 420 and max 75vw / chat room", () => {
  assert.equal(clampAgentPanelWidth(40), AGENT_PANEL_MIN);
  assert.ok(clampAgentPanelWidth(4000, 1920) <= Math.floor(1920 * 0.75));
  assert.ok(clampAgentPanelWidth(4000, 1280) <= 1280 - 248 - 500);
  assert.equal(clampAgentPanelWidth(Number.NaN), AGENT_PANEL_DEFAULT);
  assert.equal(shouldOverlayAgentPanel(1920), false);
  assert.equal(shouldOverlayAgentPanel(1280), false);
  // The composer must NEVER be covered: overlay is gone entirely.
  assert.equal(shouldOverlayAgentPanel(1000), false);
  assert.equal(shouldOverlayAgentPanel(800), false);
});

test("legacy two-pane keys migrate to one width and one tab", () => {
  const parsed = parseDesktopLayout({
    rightPanelOpen: true,
    workSurfaceWidth: 600,
    inspectorWidth: 340,
    inspectorOpen: true,
    inspectorPinned: true,
    surfaceTab: "preview:http://127.0.0.1:43173",
    inspectorTab: "diff",
    followOrion: false,
    expandedPreview: true,
  });
  assert.equal(parsed.rightPanelOpen, true);
  assert.equal(parsed.agentPanelWidth >= AGENT_PANEL_MIN, true);
  assert.equal(parsed.activeTab, "preview");
  assert.equal(parsed.followOrion, false);
  assert.equal(parsed.expandedPreview, true);
  assert.equal("inspectorOpen" in parsed, false);
});

test("workbench tabs, selected tab, width, and recent URLs survive restart", () => {
  const parsed = parseDesktopLayout({
    rightPanelOpen: true,
    agentPanelWidth: 680,
    activeTab: "browser",
    activeTabId: "preview:http://127.0.0.1:43191",
    openTabIds: ["changes", "browser", "preview:http://127.0.0.1:43191"],
    recentUrls: ["http://127.0.0.1:43191", "https://docs.example.com"],
    followOrion: false,
  });
  assert.equal(parsed.agentPanelWidth, 680);
  assert.equal(parsed.activeTabId, "preview:http://127.0.0.1:43191");
  assert.deepEqual(parsed.openTabIds, ["changes", "browser", "preview:http://127.0.0.1:43191"]);
  assert.deepEqual(parsed.recentUrls, ["http://127.0.0.1:43191", "https://docs.example.com"]);
  const stored = persistableLayout(parsed);
  assert.equal(stored.activeTabId, parsed.activeTabId);
  assert.deepEqual(stored.recentUrls, parsed.recentUrls);
});

test("app grid is two tracks when Workbench is closed", () => {
  assert.equal(
    appGridTemplateColumns({ workbenchOpen: false, overlay: false, workbenchWidth: 650 }),
    `${SIDEBAR_WIDTH}px minmax(0, 1fr)`
  );
  assert.equal(
    appGridTemplateColumns({ workbenchOpen: true, overlay: false, workbenchWidth: 650 }),
    `${SIDEBAR_WIDTH}px minmax(500px, 1fr) minmax(0, 650px)`
  );
});

test("stored activeTab and agentPanelWidth win over legacy keys", () => {
  const parsed = parseDesktopLayout({
    rightPanelOpen: true,
    activeTab: "review",
    agentPanelWidth: 480,
    inspectorTab: "files",
    surfaceTab: "changes",
  });
  assert.equal(parsed.activeTab, "review");
  assert.equal(parsed.agentPanelWidth, 480);
});

test("Tools & MCP and other full-page views do not keep the Workbench docked", () => {
  assert.equal(workbenchAllowedForView("newtask"), true);
  assert.equal(workbenchAllowedForView("home"), true);
  assert.equal(workbenchAllowedForView("editor"), true);
  assert.equal(workbenchAllowedForView("tools"), false);
  assert.equal(workbenchAllowedForView("models"), false);
  assert.equal(workbenchAllowedForView("settings"), false);
});
