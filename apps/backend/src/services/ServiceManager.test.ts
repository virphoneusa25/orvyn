import { test } from "node:test";
import assert from "node:assert/strict";
import { isServiceCommand, ServiceManager } from "./ServiceManager";

test("dev servers are services and one-shot commands are not", () => {
  assert.equal(isServiceCommand("npm test"), false);
  assert.equal(isServiceCommand("npm run build"), false);
  assert.equal(isServiceCommand("npm run dev"), true);
  assert.equal(isServiceCommand("python3 -m http.server 8080"), true);
});

test("finishing a run leaves the service record running", () => {
  const manager = new ServiceManager();
  const record = manager.start({ runId: "run-1", tenantId: "t", command: "sleep 30", cwd: "/tmp", port: 4599 });
  assert.equal(record.status, "healthy");
  assert.equal(manager.releaseRun("run-1").length, 1);
  assert.equal(manager.list("run-1")[0]?.status, "healthy");
  manager.stop(record.serviceId);
  assert.equal(manager.list("run-1")[0]?.status, "stopped");
});
