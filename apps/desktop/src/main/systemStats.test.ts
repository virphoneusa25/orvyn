import { test } from "node:test";
import assert from "node:assert/strict";
import { diskPercentFrom, ramPercentFrom } from "./systemStats.ts";

test("host metrics never invent 0 when the sample is unavailable", () => {
  assert.equal(ramPercentFrom(0, 0), null);
  assert.equal(diskPercentFrom(0, 0), null);
  assert.equal(ramPercentFrom(100, 9), 91);
});
