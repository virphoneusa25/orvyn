import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTrustedMission,
  countActiveByTenant,
  missionWorkspacePath,
  pickFairJob,
  sanitizeMissionSegment,
} from "./mission";

test("workspace paths are tenant-scoped and reject traversal", () => {
  assert.equal(
    missionWorkspacePath("/opt/orvyn/workspaces", "user_a", "run_1"),
    "/opt/orvyn/workspaces/user_a/run_1"
  );
  assert.notEqual(
    missionWorkspacePath("/opt/orvyn/workspaces", "user_a", "run_1"),
    missionWorkspacePath("/opt/orvyn/workspaces", "user_b", "run_1")
  );
  assert.throws(() => sanitizeMissionSegment("../etc"), /invalid/);
  assert.throws(() => sanitizeMissionSegment("user/a"), /invalid/);
  assert.throws(() => sanitizeMissionSegment("user\\a"), /invalid/);
  assert.throws(() => missionWorkspacePath("/ws", "user_a", "../run"), /invalid/);
});

test("mission identity must be complete and server-assigned", () => {
  const ok = assertTrustedMission({
    tenantId: "user_a",
    organizationId: "org_a",
    userId: "usr_a",
    projectId: "prj_1",
    runId: "run_1",
  });
  assert.equal(ok.tenantId, "user_a");
  assert.throws(() => assertTrustedMission({ tenantId: "user_a", runId: "run_1" }), /control plane/);
});

test("fair queue does not let one tenant consume every worker", () => {
  const jobs = [
    { tenantId: "user_a", createdAt: 1, assignedTo: undefined as string | undefined },
    { tenantId: "user_a", createdAt: 2, assignedTo: undefined as string | undefined },
    { tenantId: "user_b", createdAt: 3, assignedTo: undefined as string | undefined },
  ];
  const first = pickFairJob(jobs, new Map(), 2);
  assert.equal(first?.tenantId, "user_a");
  first!.assignedTo = "w1";
  const second = pickFairJob(jobs, countActiveByTenant(jobs), 2);
  assert.equal(second?.tenantId, "user_a");
  second!.assignedTo = "w2";
  const third = pickFairJob(jobs, countActiveByTenant(jobs), 2);
  assert.equal(third?.tenantId, "user_b");
  third!.assignedTo = "w1";
  assert.equal(pickFairJob(jobs, countActiveByTenant(jobs), 2), undefined);
});
