// apps/backend/src/queue/DistributedRuntime.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunStore } from "../agent/events";
import { DistributedRunStore } from "./DistributedRunStore";
import { RedisRunEventBridge } from "./RedisRunEventBridge";
import { findDistributedApprovalRun, isDistributedRun } from "./DistributedMissionCoordinator";
import { distributedProjectRootEligible } from "./redisConnection";

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
    sourceEventId: local?.id,
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
  let savedCursor = "0-0";
  const transport = {
    loadConsumerCursor: async () => savedCursor,
    saveConsumerCursor: async (_runId: string, id: string) => {
      savedCursor = id;
    },
    readAfter: async () => {
      if (delivered) return [];
      delivered = true;
      return [
        {
          redisId: "1-0",
          event: { runId: "run-b", sourceEventId: "worker-1", type: "run.started", timestamp: 1, data: {} },
        },
        {
          redisId: "2-0",
          event: {
            runId: "run-b",
            sourceEventId: "worker-2",
            type: "approval.required",
            timestamp: 2,
            data: { callId: "call-1" },
          },
        },
        {
          redisId: "3-0",
          event: { runId: "run-b", sourceEventId: "worker-3", type: "approval.resolved", timestamp: 3, data: { callId: "call-1" } },
        },
        {
          redisId: "4-0",
          event: { runId: "run-b", sourceEventId: "worker-4", type: "run.completed", timestamp: 4, data: {} },
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


test("RunStore restart keeps distributed runs alive but fails local in-process ghosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-runstore-"));
  try {
    const first = new RunStore(dir);

    first.create("local-run", "/workspace/local", "running");
    first.emit("local-run", "run.started", {});

    first.create("distributed-run", "/workspace/distributed", "queued");
    first.emit("distributed-run", "run.queued", { distributed: true });
    first.setStatus("distributed-run", "running");
    first.emit("distributed-run", "run.started", {});

    const recovered = new RunStore(dir);

    assert.equal(recovered.get("local-run")?.status, "error");
    const localEvents = recovered.get("local-run")?.events ?? [];
    assert.equal(
      localEvents[localEvents.length - 1]?.type,
      "run.error",
      "local process-owned runs cannot survive an API restart"
    );

    assert.equal(
      recovered.get("distributed-run")?.status,
      "running",
      "BullMQ-owned run stays live because its worker can still be executing"
    );
    assert.equal(
      recovered.get("distributed-run")?.events.some((event) => event.type === "run.error"),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RedisRunEventBridge resumes from persisted transport cursor", async () => {
  const store = new RunStore();
  store.create("run-resume", "/workspace", "running");

  let loadCount = 0;
  const seenAfter: string[] = [];
  const saved: string[] = [];
  const transport = {
    loadConsumerCursor: async () => {
      loadCount++;
      return "7-0";
    },
    saveConsumerCursor: async (_runId: string, id: string) => {
      saved.push(id);
    },
    readAfter: async (_runId: string, after: string) => {
      seenAfter.push(after);
      if (seenAfter.length > 1) return [];
      return [
        {
          redisId: "8-0",
          event: {
            runId: "run-resume",
            sourceEventId: "worker-resume-1",
            type: "run.completed",
            timestamp: Date.now(),
            data: {},
          },
        },
      ];
    },
  } as any;

  const bridge = new RedisRunEventBridge("run-resume", store, transport);
  await bridge.run();

  assert.equal(loadCount, 1);
  assert.equal(seenAfter[0], "7-0");
  assert.deepEqual(saved, ["8-0"]);
  assert.equal(store.get("run-resume")?.status, "completed");
  assert.deepEqual(store.get("run-resume")?.events.map((event) => event.type), ["run.completed"]);
  assert.equal(
    store.get("run-resume")?.events[0]?.data.__distributedSourceEventId,
    "worker-resume-1"
  );
});


test("distributedProjectRootEligible only accepts shared worker project roots", () => {
  const saved = {
    missions: process.env.ORVYN_DISTRIBUTED_MISSIONS,
    controls: process.env.ORVYN_DISTRIBUTED_CONTROLS,
    root: process.env.ORVYN_DISTRIBUTED_PROJECT_ROOT,
  };
  try {
    process.env.ORVYN_DISTRIBUTED_MISSIONS = "1";
    process.env.ORVYN_DISTRIBUTED_CONTROLS = "1";
    process.env.ORVYN_DISTRIBUTED_PROJECT_ROOT = "/projects";

    assert.equal(distributedProjectRootEligible("/projects"), true);
    assert.equal(distributedProjectRootEligible("/projects/acme"), true);
    assert.equal(distributedProjectRootEligible("/projects/acme/web"), true);

    assert.equal(distributedProjectRootEligible("/project/acme"), false);
    assert.equal(distributedProjectRootEligible("/Users/royce/project"), false);
    assert.equal(distributedProjectRootEligible("C:\\Users\\Royce\\project"), false);

    process.env.ORVYN_DISTRIBUTED_CONTROLS = "0";
    assert.equal(
      distributedProjectRootEligible("/projects/acme"),
      false,
      "feature flags still fail closed"
    );
  } finally {
    if (saved.missions === undefined) delete process.env.ORVYN_DISTRIBUTED_MISSIONS;
    else process.env.ORVYN_DISTRIBUTED_MISSIONS = saved.missions;
    if (saved.controls === undefined) delete process.env.ORVYN_DISTRIBUTED_CONTROLS;
    else process.env.ORVYN_DISTRIBUTED_CONTROLS = saved.controls;
    if (saved.root === undefined) delete process.env.ORVYN_DISTRIBUTED_PROJECT_ROOT;
    else process.env.ORVYN_DISTRIBUTED_PROJECT_ROOT = saved.root;
  }
});


test("RedisRunEventBridge deduplicates a worker event replayed after an API crash", async () => {
  const store = new RunStore();
  store.create("run-dedupe", "/workspace", "running");
  store.emit("run-dedupe", "tool.completed", {
    tool: "terminal",
    __distributedSourceEventId: "worker-event-42",
  });

  const transport = {
    loadConsumerCursor: async () => "40-0",
    saveConsumerCursor: async () => undefined,
    readAfter: async () => [
      {
        redisId: "41-0",
        event: {
          runId: "run-dedupe",
          sourceEventId: "worker-event-42",
          type: "tool.completed",
          timestamp: Date.now(),
          data: { tool: "terminal" },
        },
      },
      {
        redisId: "42-0",
        event: {
          runId: "run-dedupe",
          sourceEventId: "worker-event-43",
          type: "run.completed",
          timestamp: Date.now(),
          data: {},
        },
      },
    ],
  } as any;

  let calls = 0;
  transport.readAfter = async () => {
    calls++;
    if (calls > 1) return [];
    return [
      {
        redisId: "41-0",
        event: {
          runId: "run-dedupe",
          sourceEventId: "worker-event-42",
          type: "tool.completed",
          timestamp: Date.now(),
          data: { tool: "terminal" },
        },
      },
      {
        redisId: "42-0",
        event: {
          runId: "run-dedupe",
          sourceEventId: "worker-event-43",
          type: "run.completed",
          timestamp: Date.now(),
          data: {},
        },
      },
    ];
  };

  const bridge = new RedisRunEventBridge("run-dedupe", store, transport);
  await bridge.run();

  assert.equal(
    store.get("run-dedupe")?.events.filter((event) => event.type === "tool.completed").length,
    1,
    "replayed worker event must not duplicate the already-durable API event"
  );
  assert.equal(store.get("run-dedupe")?.status, "completed");
});
