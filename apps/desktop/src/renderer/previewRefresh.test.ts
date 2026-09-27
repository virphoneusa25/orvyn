import { test } from "node:test";
import assert from "node:assert/strict";
import { planPreviewRefresh } from "./previewRefresh.ts";

const url = "http://127.0.0.1:4693/api/v1/sites/site-1/";

test("a preview update refreshes the existing tab and does not open another", () => {
  const plan = planPreviewRefresh({
    url,
    revision: 2,
    followActive: true,
    tabs: [
      { id: "files", url: undefined },
      { id: "preview-1", url },
    ],
  });
  assert.deepEqual(plan, { reloadId: "preview-1", focus: true, revision: 2 });
});

test("a paused follow still names the same tab and does not ask to steal focus", () => {
  const plan = planPreviewRefresh({
    url: url.replace(/\/$/, ""),
    revision: 3,
    followActive: false,
    seenRevision: 2,
    tabs: [{ id: "preview-1", url }],
  });
  assert.equal(plan?.reloadId, "preview-1");
  assert.equal(plan?.focus, false);
});

test("an update with no open preview does not create a tab", () => {
  assert.equal(planPreviewRefresh({
    url,
    revision: 1,
    followActive: true,
    tabs: [{ id: "other", url: "http://127.0.0.1:8080/" }],
  }), null);
  assert.equal(planPreviewRefresh({
    url,
    revision: 2,
    followActive: true,
    seenRevision: 2,
    tabs: [{ id: "preview-1", url }],
  }), null);
});
