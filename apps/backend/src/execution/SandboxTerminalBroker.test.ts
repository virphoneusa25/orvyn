import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxTerminalBroker } from "./SandboxTerminalBroker";

test("sandbox terminal relay keeps sessions tenant and run scoped", () => {
  const broker = new SandboxTerminalBroker();
  const session = broker.open("run-a", "tenant-a", 100, 30);
  assert.equal(broker.get(session.id, "tenant-b"), null);
  assert.equal(broker.input(session.id, "tenant-b", "stolen"), false);

  const open = broker.poll("run-a");
  assert.equal(open?.type, "open");
  assert.equal(open?.cols, 100);
  assert.equal(broker.poll("run-b"), null);

  assert.equal(broker.input(session.id, "tenant-a", "echo ok\n"), true);
  assert.equal(broker.poll("run-a")?.data, "echo ok\n");
  assert.equal(broker.push(session.id, { type: "output", data: "ok\n" }), true);
  assert.deepEqual(broker.read(session.id, "tenant-a", 0)?.events.map((event) => event.data), ["ok\n"]);
  assert.equal(broker.read(session.id, "tenant-a", 1)?.events.length, 0);

  broker.closeRun("run-a");
  assert.equal(broker.read(session.id, "tenant-a", 0)?.closed, true);
  assert.equal(broker.poll("run-a")?.type, "close");
});
