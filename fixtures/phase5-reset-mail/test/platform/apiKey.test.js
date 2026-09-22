const { test } = require("node:test");
const assert = require("node:assert/strict");
const { apiKeyValue, apiKeyReady } = require("../../src/platform/apiKey");
test("platform/apiKey helpers", () => {
  assert.equal(apiKeyValue("x"), "x");
  assert.equal(apiKeyReady(), true);
});
