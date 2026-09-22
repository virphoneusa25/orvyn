const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cohortValue, cohortReady } = require("../../src/analytics/cohort");
test("analytics/cohort helpers", () => {
  assert.equal(cohortValue("x"), "x");
  assert.equal(cohortReady(), true);
});
