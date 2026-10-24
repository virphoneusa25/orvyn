import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinComputerUseHit } from "./modelComputerCapabilities";

test("capability search treats website screenshots as browser work, not Desktop computer-use", () => {
  assert.equal(builtinComputerUseHit("screenshot the landing page"), false);
  assert.equal(builtinComputerUseHit("take a screenshot of the website"), false);
  assert.equal(builtinComputerUseHit("visual qa of the browser page"), false);
  assert.equal(builtinComputerUseHit("computer_screenshot of the installer window"), true);
  assert.equal(builtinComputerUseHit("screenshot the desktop"), true);
  assert.equal(builtinComputerUseHit("computer use click through the app"), true);
});
