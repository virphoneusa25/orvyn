// apps/desktop/src/renderer/appReattach.test.ts
//
// Regression coverage for restart reattachment: an app relaunch must attach
// the NEWEST still-in-flight run (so a restart never orphans live work) and
// never attach a terminal run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReattachRun } from "./appReattach.ts";

test("reattaches the newest in-flight run", () => {
  const id = pickReattachRun([
    { id: "done", status: "completed", createdAt: 300 },
    { id: "old-active", status: "running", createdAt: 100 },
    { id: "new-active", status: "awaiting_approval", createdAt: 200 },
  ]);
  assert.equal(id, "new-active");
});

test("never reattaches terminal-only history", () => {
  assert.equal(
    pickReattachRun([
      { id: "a", status: "completed", createdAt: 1 },
      { id: "b", status: "error", createdAt: 2 },
      { id: "c", status: "cancelled", createdAt: 3 },
    ]),
    null
  );
});

test("empty or missing list reattaches nothing", () => {
  assert.equal(pickReattachRun([]), null);
});
