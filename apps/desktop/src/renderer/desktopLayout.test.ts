import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampInspectorWidth,
  clampTerminalHeight,
  clampWorkSurfaceWidth,
  INSPECTOR_DEFAULT,
  INSPECTOR_MIN,
  parseDesktopLayout,
  persistableLayout,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  WORK_SURFACE_DEFAULT,
  WORK_SURFACE_MIN,
} from "./desktopLayout.ts";

test("an explicit true preference means the right panel should show", () => {
  assert.equal(parseDesktopLayout({ rightPanelOpen: true }).rightPanelOpen, true);
});

test("right panel / terminal / help parse with safe defaults", () => {
  const empty = parseDesktopLayout(null);
  assert.equal(empty.rightPanelOpen, false);
  assert.equal(empty.bottomTerminalOpen, false);
  assert.equal(empty.helpOpen, false);
  assert.equal(empty.bottomTerminalHeight, TERMINAL_DEFAULT_HEIGHT);

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

test("persistence omits ephemeral help and stores workspace prefs", () => {
  const stored = persistableLayout({
    rightPanelOpen: false,
    bottomTerminalOpen: true,
    bottomTerminalHeight: 260,
    helpOpen: true,
    workSurfaceWidth: 560,
    inspectorWidth: 320,
    inspectorOpen: true,
    inspectorPinned: false,
    surfaceTab: "changes",
    inspectorTab: "files",
    followOrion: true,
    expandedPreview: false,
  });
  assert.equal("helpOpen" in stored, false);
  assert.equal(stored.rightPanelOpen, false);
  assert.equal(stored.bottomTerminalOpen, true);
  assert.equal(stored.bottomTerminalHeight, 260);
  assert.equal(stored.workSurfaceWidth, 560);
  assert.equal(stored.inspectorWidth, 320);
  assert.equal(stored.followOrion, true);
});

test("workspace widths clamp to chat and inspector room", () => {
  assert.equal(clampWorkSurfaceWidth(40), WORK_SURFACE_MIN);
  assert.ok(clampWorkSurfaceWidth(4000, 1200, true, 320) >= WORK_SURFACE_MIN);
  assert.ok(clampWorkSurfaceWidth(4000, 1200, true, 320) <= Math.floor(1200 * 0.65));
  assert.equal(clampInspectorWidth(40), INSPECTOR_MIN);
  assert.ok(clampInspectorWidth(900, 1200) <= 480);
  assert.equal(clampWorkSurfaceWidth(Number.NaN), WORK_SURFACE_DEFAULT);
  assert.equal(clampInspectorWidth(Number.NaN), INSPECTOR_DEFAULT);
});

test("default and empty parse keep Inspector closed", () => {
  const empty = parseDesktopLayout(null);
  assert.equal(empty.inspectorOpen, false);
  assert.equal(empty.inspectorPinned, false);
});

test("layout parse restores tabs, follow, and split widths", () => {
  const parsed = parseDesktopLayout({
    rightPanelOpen: true,
    workSurfaceWidth: 600,
    inspectorWidth: 340,
    inspectorOpen: false,
    surfaceTab: "preview:http://127.0.0.1:43173",
    inspectorTab: "diff",
    followOrion: false,
    expandedPreview: true,
  });
  assert.equal(parsed.rightPanelOpen, true);
  assert.equal(parsed.workSurfaceWidth >= WORK_SURFACE_MIN, true);
  assert.equal(parsed.inspectorWidth, 340);
  assert.equal(parsed.inspectorOpen, false);
  assert.equal(parsed.inspectorPinned, false);
  assert.equal(parsed.surfaceTab, "preview:http://127.0.0.1:43173");
  assert.equal(parsed.inspectorTab, "diff");
  assert.equal(parsed.followOrion, false);
  assert.equal(parsed.expandedPreview, true);
});
