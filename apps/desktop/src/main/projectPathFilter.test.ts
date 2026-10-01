import { test } from "node:test";
import assert from "node:assert/strict";
import { isCustomerProjectPath, filterCustomerProjectPaths } from "./projectPathFilter.ts";

test("recent projects hide .orvyn, fixtures, and internal workspaces", () => {
  assert.equal(isCustomerProjectPath("C:/Users/me/app"), true);
  assert.equal(isCustomerProjectPath("C:/Users/me/.orvyn"), false);
  assert.equal(isCustomerProjectPath("C:/repo/.orvyn/workspace"), false);
  assert.equal(isCustomerProjectPath("C:/repo/apps/desktop/fixtures"), false);
  assert.equal(isCustomerProjectPath("C:/repo/test-fixtures/sample"), false);
  assert.equal(isCustomerProjectPath("C:/Users/me/@orvyn/desktop/workspace"), false);
  assert.equal(isCustomerProjectPath("C:/repo/node_modules/foo"), false);
  const kept = filterCustomerProjectPaths([
    "C:/proj",
    "C:/proj/.orvyn",
    "C:/viride/apps/desktop/fixtures",
    "C:/proj",
  ]);
  assert.deepEqual(kept, ["C:/proj"]);
});
