import assert from "node:assert/strict";
import test from "node:test";
import { workspaceBounds, workspaceWidth, storedWorkspaceShare } from "./workspaceSplit.ts";
test("pane widths clamp to the available container while keeping chat usable", () => {
  assert.deepEqual(workspaceBounds(1200), { min: 300, max: 872 });
  assert.equal(workspaceWidth(1200, 1), 872);
  assert.equal(workspaceWidth(1200, 0), 300);
  assert.equal(workspaceWidth(1200, 0.44), 528);
  assert.ok(workspaceWidth(600, 0.9) <= 300);
});
test("invalid saved widths and NaN fall back safely", () => {
  for (const value of [null, "", "NaN", "-1", "1", "garbage"]) assert.equal(storedWorkspaceShare(value), 0.44);
  assert.equal(storedWorkspaceShare("0.62"), 0.62);
  assert.equal(workspaceWidth(1200, NaN), 528);
});