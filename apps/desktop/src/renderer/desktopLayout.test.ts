import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTerminalHeight,
  parseDesktopLayout,
  persistableLayout,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
} from "./desktopLayout.ts";

test("right panel / terminal / help parse with safe defaults", () => {
  const empty = parseDesktopLayout(null);
  assert.equal(empty.rightPanelOpen, true);
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

test("persistence omits ephemeral help and stores only layout prefs", () => {
  const stored = persistableLayout({
    rightPanelOpen: false,
    bottomTerminalOpen: true,
    bottomTerminalHeight: 260,
    helpOpen: true,
  });
  assert.equal("helpOpen" in stored, false);
  assert.deepEqual(stored, {
    rightPanelOpen: false,
    bottomTerminalOpen: true,
    bottomTerminalHeight: 260,
  });
});
