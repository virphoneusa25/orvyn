// apps/backend/src/agent/TaskEngine.distributed.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./EventBus";
import { RunStore } from "./events";
import { Mission, TaskEngine } from "./TaskEngine";

class MemoryMissionStore {
  private missions = new Map<string, Mission>();

  constructor(seed: Mission[] = []) {
    for (const mission of seed) {
      this.missions.set(mission.id, structuredClone(mission));
    }
  }

  async loadMissions(): Promise<Mission[]> {
    return Array.from(this.missions.values()).map((mission) =>
      structuredClone(mission)
    );
  }

  async saveMission(mission: Mission): Promise<void> {
    this.missions.set(mission.id, structuredClone(mission));
  }
}

function mission(status: Mission["status"] = "RUNNING"): Mission {
  return {
    id: "mission_shared",
    runId: "run_shared",
    projectRoot: "/projects/shared",
    goal: "shared mission",
    status,
    tasks: [],
    reviewCycles: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function engine(
  store: MemoryMissionStore,
  options: ConstructorParameters<typeof TaskEngine>[2] = {}
): TaskEngine {
  return new TaskEngine(
    new EventBus(new RunStore()),
    store as any,
    options
  );
}

test("local warm-start still marks abandoned in-flight missions failed", async () => {
  const store = new MemoryMissionStore([mission("RUNNING")]);
  const local = engine(store);
  await local.hydrate();

  assert.equal(local.getMission("mission_shared")?.status, "FAILED");
  assert.equal((await store.loadMissions())[0]?.status, "FAILED");
});

test("distributed worker construction never fails another worker's active mission", async () => {
  const store = new MemoryMissionStore([mission("RUNNING")]);
  const worker = engine(store, {
    shouldFailRecoveredMission: () => false,
  });
  await worker.hydrate();

  assert.equal(worker.getMission("mission_shared")?.status, "RUNNING");
  assert.equal(
    (await store.loadMissions())[0]?.status,
    "RUNNING",
    "constructing a second worker must not mutate another live mission"
  );
});

test("distributed API refresh sees missions and tasks persisted by a worker", async () => {
  const store = new MemoryMissionStore();

  const api = engine(store, {
    shouldFailRecoveredMission: () => false,
  });
  const worker = engine(store, {
    shouldFailRecoveredMission: () => false,
  });
  await api.hydrate();
  await worker.hydrate();

  const created = await worker.createMission(
    "run_worker",
    "/projects/acme",
    "build feature"
  );
  await worker.setMissionStatus(created.id, "RUNNING");
  const task = await worker.addTask(created.id, "edit source", "coder");
  assert.ok(task);
  await worker.transition(created.id, task!.id, "RUNNING");

  await api.refresh();
  const visible = api.listMissions().find((m) => m.id === created.id);
  assert.ok(visible, "API should discover a mission created by another process");
  assert.equal(visible?.status, "RUNNING");
  assert.equal(visible?.tasks.length, 1);
  assert.equal(visible?.tasks[0]?.status, "RUNNING");

  await worker.transition(created.id, task!.id, "COMPLETED");
  await worker.setMissionStatus(created.id, "COMPLETED");

  await api.refresh();
  const refreshed = api.getMission(created.id);
  assert.equal(refreshed?.status, "COMPLETED");
  assert.equal(refreshed?.tasks[0]?.status, "COMPLETED");
});
