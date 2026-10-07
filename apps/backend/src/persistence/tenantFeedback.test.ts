import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./LocalStore";

test("local feedback retains legacy rows, recovers malformed JSON, and bounds history", () => {
  const store = new LocalStore("fixture", mkdtempSync(join(tmpdir(), "orvyn-feedback-")));
  try {
    store.setSetting("feedback", JSON.stringify([{ runId: "legacy", kind: "up", at: "fixture" }]));
    store.appendRunFeedback("new", "down", "fixture");
    assert.deepEqual(JSON.parse(store.getSetting("feedback")!).map((row: any) => row.runId), ["legacy", "new"]);
    store.setSetting("feedback", "invalid-json"); store.appendRunFeedback("recovered", "up", "fixture");
    assert.equal(JSON.parse(store.getSetting("feedback")!)[0].runId, "recovered");
    store.setSetting("feedback", JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ runId: "old-" + i }))));
    store.appendRunFeedback("latest", "up", "fixture");
    const rows = JSON.parse(store.getSetting("feedback")!);
    assert.equal(rows.length, 500); assert.equal(rows[0].runId, "old-1"); assert.equal(rows[499].runId, "latest");
  } finally { store.close(); }
});
