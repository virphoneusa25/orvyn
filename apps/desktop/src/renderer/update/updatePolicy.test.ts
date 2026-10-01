import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudMissionsBlockedByUpdate } from "./desktopUpdateTypes.ts";
import { requiredUpdateBlocksCloudSubmit, setRequiredDesktopUpdate } from "./updateGate.ts";

test("required update blocks cloud missions without implying the app is broken", () => {
  assert.equal(cloudMissionsBlockedByUpdate({ required: true }), true);
  assert.equal(cloudMissionsBlockedByUpdate({ required: false }), false);
  assert.equal(cloudMissionsBlockedByUpdate(null), false);
  setRequiredDesktopUpdate(true);
  assert.equal(requiredUpdateBlocksCloudSubmit(), true);
  setRequiredDesktopUpdate(false);
  assert.equal(requiredUpdateBlocksCloudSubmit(), false);
});
