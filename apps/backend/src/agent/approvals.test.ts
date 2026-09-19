// apps/backend/src/agent/approvals.test.ts
//
// The regression these tests pin: an approval nobody answers used to hang its
// run (and its mission-queue slot) forever. Reproduced live — two zombie runs
// starved every later mission while the UI showed a permanent "analyzing…".

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalTimeoutSeconds, raceApprovalTimeout } from "./approvals";

test("approvalTimeoutSeconds: default 600, explicit values honored, 0 disables, junk falls back", () => {
  const saved = process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
  try {
    delete process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
    assert.equal(approvalTimeoutSeconds(), 600);

    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "30";
    assert.equal(approvalTimeoutSeconds(), 30);

    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "0";
    assert.equal(approvalTimeoutSeconds(), 0);

    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "not-a-number";
    assert.equal(approvalTimeoutSeconds(), 600);

    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "-5";
    assert.equal(approvalTimeoutSeconds(), 0);
  } finally {
    if (saved === undefined) delete process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
    else process.env.ORVYN_APPROVAL_TIMEOUT_SEC = saved;
  }
});

test("raceApprovalTimeout: user decision wins and cleans up the registration", async () => {
  const saved = process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
  process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "1";
  try {
    let settle!: (approved: boolean) => void;
    let cleaned = false;
    const p = raceApprovalTimeout((s) => {
      settle = s;
      return () => {
        cleaned = true;
      };
    });
    settle(true);
    const out = await p;
    assert.deepEqual(out, { approved: true, timedOut: false, seconds: 1 });
    assert.equal(cleaned, true, "registration must be cleaned up once decided");
  } finally {
    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = saved;
  }
});

test("raceApprovalTimeout: silence denies after the timeout and cleans up", async () => {
  const saved = process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
  process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "1"; // smallest honest value
  try {
    let cleaned = false;
    const start = Date.now();
    const p = raceApprovalTimeout(() => () => {
      cleaned = true;
    });
    const out = await p;
    assert.equal(out.approved, false);
    assert.equal(out.timedOut, true);
    assert.equal(out.seconds, 1);
    assert.ok(Date.now() - start >= 900, "timeout fired after ~the configured second");
    assert.equal(cleaned, true, "pending registration removed on timeout so later user approval is a no-op");
  } finally {
    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = saved;
  }
});

test("raceApprovalTimeout: a late user decision after timeout is ignored", async () => {
  const saved = process.env.ORVYN_APPROVAL_TIMEOUT_SEC;
  process.env.ORVYN_APPROVAL_TIMEOUT_SEC = "1";
  try {
    const holder: { settle?: (approved: boolean) => void } = {};
    const p = raceApprovalTimeout((s) => {
      holder.settle = s;
      return () => {
        delete holder.settle;
      };
    });
    await new Promise((r) => setTimeout(r, 1300));
    const timedOut = await p;
    assert.equal(timedOut.timedOut, true);
    // The endpoint would call the stale resolver — it must be a no-op.
    holder.settle?.(true);
  } finally {
    process.env.ORVYN_APPROVAL_TIMEOUT_SEC = saved;
  }
});
