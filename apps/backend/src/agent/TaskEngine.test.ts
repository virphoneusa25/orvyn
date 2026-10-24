import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskEngine, type Mission } from "./TaskEngine";
import type { EventBus } from "./EventBus";

function events() {
  const log: string[] = [];
  const bus = { missionCreated: () => log.push("created"), missionStarted: () => log.push("started"), missionCompleted: () => log.push("completed"), missionBlocked: () => log.push("blocked"), taskCreated: () => log.push("task") } as unknown as EventBus;
  return { log, bus };
}

test("mission creation waits for storage acknowledgement before events and history", async () => {
  const { log, bus } = events();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  const engine = new TaskEngine(bus, { loadMissions: async () => [], saveMission: async () => { await gate; } });
  const creation = engine.createMission("run", "/project", "build").then((m) => { finished = true; return m; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(log, []);
  release();
  const mission = await creation;
  assert.deepEqual(log, ["created"]);
  assert.equal(await engine.getMission(mission.id), mission);
});

test("failed mission writes leave status unchanged and concurrent tasks retain unique identities", async () => {
  const { log, bus } = events();
  let fail = false;
  const saved = new Map<string, Mission>();
  const engine = new TaskEngine(bus, { loadMissions: async () => [], saveMission: async (m) => { if (fail) throw new Error("storage unavailable"); saved.set(m.id, structuredClone(m)); } });
  const mission = await engine.createMission("run", "/project", "build");
  fail = true;
  await assert.rejects(engine.setMissionStatus(mission.id, "RUNNING"), /storage unavailable/);
  assert.equal(mission.status, "QUEUED");
  assert.deepEqual(log, ["created"]);
  fail = false;
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => engine.addTask(mission.id, `task ${i}`, "coder")));
  assert.equal(new Set(tasks.map((t) => t!.id)).size, 12);
  const first = tasks[0]!;
  first.attempts = 1;
  await engine.transition(mission.id, first.id, "RUNNING");
  assert.equal(first.status, "RUNNING");
  assert.equal(saved.get(mission.id)!.tasks[0]!.attempts, 1);
  fail = true;
  await assert.rejects(engine.transition(mission.id, first.id, "COMPLETED"), /storage unavailable/);
  assert.equal(first.status, "RUNNING");
});

test("mission restart waits for interrupted-state reconciliation and propagates database errors", async () => {
  const original: Mission = { id: "mission", runId: "run", projectRoot: "/project", goal: "build", status: "RUNNING", tasks: [], reviewCycles: 0, createdAt: 1, updatedAt: 1 };
  const { bus } = events();
  const saved: Mission[] = [];
  const engine = new TaskEngine(bus, { loadMissions: async () => [original], saveMission: async (m) => { saved.push(structuredClone(m)); } });
  assert.equal((await engine.getMission("mission"))!.status, "FAILED");
  assert.equal(saved[0]!.status, "FAILED");
  assert.equal(original.status, "RUNNING");
  const unavailable = new TaskEngine(bus, { loadMissions: async () => { throw new Error("storage unavailable"); }, saveMission: async () => {} });
  await assert.rejects(unavailable.listMissions(), /storage unavailable/);
  await assert.rejects(unavailable.createMission("run", "/project", "build"), /storage unavailable/);
});
