import { test } from "node:test";
import assert from "node:assert/strict";
import { placePopover, WORKBENCH_Z } from "./WorkbenchOverlay.tsx";

test("overlay z-index scale is content < tabbar < popover < modal < tooltip", () => {
  assert.equal(WORKBENCH_Z.content, 10);
  assert.equal(WORKBENCH_Z.tabbar, 20);
  assert.equal(WORKBENCH_Z.popover, 1000);
  assert.equal(WORKBENCH_Z.modal, 2000);
  assert.equal(WORKBENCH_Z.tooltip, 3000);
});

test("popover flips above the anchor when there is no room below", () => {
  const anchor = { top: 700, bottom: 732, left: 20, right: 46, width: 26, height: 32 } as DOMRect;
  const pos = placePopover(anchor, 280, 360, "left", { width: 1280, height: 800 });
  assert.ok(pos.top + 360 <= 800, "menu stays in a typical viewport");
  assert.ok(pos.top < anchor.top, "menu flips above when clipped below");
  assert.ok(pos.left >= 8);
});

test("popover clamps to the right edge of the viewport", () => {
  const anchor = { top: 40, bottom: 72, left: 1200, right: 1230, width: 30, height: 32 } as DOMRect;
  const pos = placePopover(anchor, 340, 240, "right", { width: 1280, height: 800 });
  assert.ok(pos.left + 340 <= 1280);
  assert.ok(pos.left >= 8);
});
