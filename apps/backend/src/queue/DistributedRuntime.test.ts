// apps/backend/src/queue/DistributedRuntime.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../agent/events";
import { DistributedRunStore } from "./DistributedRunStore";
import { RedisRunEventBridge } from "./RedisRunEventBridge";
import { findDistributedApprovalRun, isDistributedRun } from "./DistributedMissionCoordinator";

test("DistributedRunStore forwards raw event envelopes without owning SSE sequence", async () => {
  const published: any[] = [];
  const transport = {
    publish: async (event: any) => {
      published.push(event);
      return "1-0";
    },
  } as any;

  const store = new DistributedRunStore(transport);
  store.create("run-a", "/workspace", "queued");
  const local = store.emit("run-a", "run.started", { instruction: "test" });
  await store.flush();

  assert.equal(local?.sequence, 1);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    runId: "run-a",
    type: "run.started",
    timestamp: local?.timestamp,
    data: { instruction: "test" },
  });
  assert.equal("sequence" in published[0], false);
});

test("RedisRunEventBridge makes API RunStore authoritative for sequence and status", async () => {
  const store = new RunStore();
  store.create("run-b", "/workspace", "queued");

  let delivered = false;
  const transport = {
    readAfter: async () => {
      if (delivered) return [];
      delivered = true;
      return [
        {
          redisId: "1-0",
          event: { runId: "run-b", type: "run.started", timestamp: 1, data: {} },
        },
        {
          redisId: "2-0",
          event: {
            runId: "run-b",
            type: "approval.required",
            timestamp: 2,
            data: { callId: "call-1" },
          },
        },
        {
          redisId: "3-0",
          event: { runId: "run-b", type: "approval.resolved", timestamp: 3, data: { callId: "call-1" } },
        },
        {
          redisId: "4-0",
          event: { runId: "run-b", type: "run.completed", timestamp: 4, data: {} },
        },
      ];
    },
  } as any;

  const bridge = new RedisRunEventBridge("run-b", store, transport);
  await bridge.run();

  const run = store.get("run-b");
  assert.equal(run?.status, "completed");
  assert.deepEqual(run?.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(run?.events.map((event) => event.type), [
    "run.started",
    "approval.required",
    "approval.resolved",
    "run.completed",
  ]);
});

test("distributed run helpers locate unresolved approvals only", () => {
  const store = new RunStore();
  store.create("run-c", "/workspace", "queued");
  store.emit("run-c", "run.queued", { distributed: true });
  store.emit("run-c", "approval.required", { callId: "call-c" });

  const run = store.get("run-c")!;
  assert.equal(isDistributedRun(run), true);
  assert.equal(findDistributedApprovalRun(store.list(), "call-c")?.id, "run-c");

  store.emit("run-c", "approval.resolved", { callId: "call-c", approved: true });
  assert.equal(findDistributedApprovalRun(store.list(), "call-c"), undefined);
});
