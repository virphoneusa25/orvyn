import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_IPC,
  handleWindowAction,
  maximizeIconLabel,
  validateSaveTextPayload,
  validateClipboardText,
} from "./windowIpc.ts";

function fakeWindow(initialMax = false) {
  let maximized = initialMax;
  let minimized = false;
  let closed = false;
  return {
    minimize() {
      minimized = true;
    },
    maximize() {
      maximized = true;
    },
    unmaximize() {
      maximized = false;
    },
    close() {
      closed = true;
    },
    isMaximized() {
      return maximized;
    },
    get flags() {
      return { maximized, minimized, closed };
    },
  };
}

test("IPC channel names stay explicit and do not expose ipcRenderer", () => {
  assert.equal(WINDOW_IPC.minimize, "window:minimize");
  assert.equal(WINDOW_IPC.toggleMaximize, "window:toggleMaximize");
  assert.equal(WINDOW_IPC.toggleMaximizeAlias, "window:toggle-maximize");
  assert.equal(WINDOW_IPC.close, "window:close");
  assert.equal(WINDOW_IPC.getState, "window:get-state");
  assert.equal(WINDOW_IPC.maximizedPush, "window:maximized");
});

test("minimize / close call the real window methods", () => {
  const win = fakeWindow();
  handleWindowAction(win, "minimize");
  handleWindowAction(win, "close");
  assert.equal(win.flags.minimized, true);
  assert.equal(win.flags.closed, true);
});

test("toggleMaximize maximizes then restores from actual state", () => {
  const win = fakeWindow(false);
  assert.equal(handleWindowAction(win, "toggleMaximize"), true);
  assert.equal(win.flags.maximized, true);
  assert.equal(handleWindowAction(win, "toggleMaximize"), false);
  assert.equal(win.flags.maximized, false);
});

test("getState and isMaximized report BrowserWindow state, not screen size", () => {
  const win = fakeWindow(true);
  assert.deepEqual(handleWindowAction(win, "getState"), { maximized: true });
  assert.equal(handleWindowAction(win, "isMaximized"), true);
  win.unmaximize();
  assert.deepEqual(handleWindowAction(null, "getState"), { maximized: false });
});

test("maximize icon label follows real maximized state", () => {
  assert.equal(maximizeIconLabel(false), "Maximize");
  assert.equal(maximizeIconLabel(true), "Restore");
});

test("save-text payload rejects paths, oversized content, and non-strings", () => {
  assert.equal(validateSaveTextPayload(null), null);
  assert.equal(validateSaveTextPayload({ content: 1 }), null);
  assert.equal(validateSaveTextPayload({ content: "x".repeat(2_000_001) }), null);
  const ok = validateSaveTextPayload({ content: "# hi", defaultName: "../secrets/key.md" });
  assert.ok(ok);
  assert.equal(ok.defaultName.includes(".."), false);
  assert.equal(ok.defaultName.includes("/"), false);
  assert.equal(ok.content, "# hi");
});

test("clipboard write validates input", () => {
  assert.equal(validateClipboardText(12), null);
  assert.equal(validateClipboardText("run-id"), "run-id");
});
