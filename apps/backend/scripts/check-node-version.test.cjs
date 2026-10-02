const assert = require("node:assert/strict");
const test = require("node:test");
const { assertSupportedNode } = require("./check-node-version.cjs");

test("accepts the minimum supported runtime and newer majors", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.13.0"));
  assert.doesNotThrow(() => assertSupportedNode("22.13.1"));
  assert.doesNotThrow(() => assertSupportedNode("24.0.0"));
});

test("rejects versions below the runtime floor", () => {
  for (const version of ["18.20.0", "20.19.0", "22.5.0", "22.12.99"]) {
    assert.throws(() => assertSupportedNode(version), /requires Node\.js >=22\.13\.0/);
  }
});
