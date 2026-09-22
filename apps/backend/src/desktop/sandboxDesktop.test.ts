import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSandboxPoint, resolveKeyCombo } from "./sandboxDesktop";

const session = { width: 1280, height: 720 };

test("mapSandboxPoint scales view coords to remote resolution", () => {
  // A view exactly half the remote size maps 1:2.
  assert.deepEqual(mapSandboxPoint(session, 320, 180, 640, 360), { x: 640, y: 360 });
  // Identity view.
  assert.deepEqual(mapSandboxPoint(session, 100, 100, 1280, 720), { x: 100, y: 100 });
  // Upscaled view (e.g. fullscreen on a larger monitor).
  assert.deepEqual(mapSandboxPoint(session, 960, 540, 1920, 1080), { x: 640, y: 360 });
});

test("mapSandboxPoint clamps into the remote framebuffer", () => {
  assert.deepEqual(mapSandboxPoint(session, -10, -10, 1280, 720), { x: 0, y: 0 });
  assert.deepEqual(mapSandboxPoint(session, 9999, 9999, 1280, 720), { x: 1279, y: 719 });
  // Degenerate view dims cannot divide by zero.
  assert.deepEqual(mapSandboxPoint(session, 50, 50, 0, 0), { x: 50, y: 50 });
});

test("resolveKeyCombo maps the Send-Keys menu", () => {
  assert.equal(resolveKeyCombo("ctrlaltdel"), "ctrl+alt+Delete");
  assert.equal(resolveKeyCombo("Ctrl+Alt+Del"), "ctrl+alt+Delete");
  assert.equal(resolveKeyCombo("ctrl+c"), "ctrl+c");
  assert.equal(resolveKeyCombo("ctrl+v"), "ctrl+v");
  assert.equal(resolveKeyCombo("alt+tab"), "alt+Tab");
  assert.equal(resolveKeyCombo("esc"), "Escape");
  assert.equal(resolveKeyCombo("enter"), "Return");
});

test("resolveKeyCombo accepts safe custom combos, rejects junk", () => {
  assert.equal(resolveKeyCombo("ctrl+shift+t"), "ctrl+shift+t");
  assert.equal(resolveKeyCombo("F5"), "F5");
  assert.equal(resolveKeyCombo("rm -rf /"), null);
  assert.equal(resolveKeyCombo("a".repeat(100)), null);
  assert.equal(resolveKeyCombo(""), null);
});
