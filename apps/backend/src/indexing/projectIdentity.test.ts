import { test } from "node:test";
import assert from "node:assert/strict";
import { logicalProjectId } from "./projectIdentity";

test("logical project id is tenant-scoped and stable", () => {
  const a = logicalProjectId("tenant_a", "/Users/royce/work/website");
  const b = logicalProjectId("tenant_a", "/Users/royce/work/website");
  const c = logicalProjectId("tenant_b", "/Users/royce/work/website");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes("/Users/"));
});

test("explicit project id wins when well-formed", () => {
  assert.equal(logicalProjectId("t", "/tmp/orvyn-mission-abc", "website-core"), "website-core");
});
