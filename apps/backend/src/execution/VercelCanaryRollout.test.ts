// apps/backend/src/execution/VercelCanaryRollout.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCloudExecutionProvider,
  setEmergencyDisableVercel,
  addCanaryUser,
  removeCanaryUser,
  addCanaryTenant,
  removeCanaryTenant,
  VERCEL_CANARY_FLAG,
} from "./VercelCanaryRollout";

test("VercelCanaryRollout: defaults to OVH worker for unlisted customer accounts", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "ovh",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "user-cust-1", tenantId: "tenant-cust-1", isStaff: false },
    env
  );
  assert.equal(decision.provider, "ovh");
  assert.equal(decision.location, "OVH_WORKER");
  assert.equal(decision.eligible, false);
});

test("VercelCanaryRollout: emergency disable switch blocks Vercel for all accounts", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "vercel",
    VERCEL_CANARY_USERS: "user-admin-1",
    ORVYN_CLOUD_EMERGENCY_DISABLE_VERCEL: "true",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "user-admin-1", tenantId: "tenant-admin-1", isStaff: true },
    env
  );
  assert.equal(decision.provider, "ovh");
  assert.equal(decision.location, "OVH_WORKER");
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /emergency switch/i);
});

test("VercelCanaryRollout: programmatic emergency disable blocks Vercel immediately", async () => {
  setEmergencyDisableVercel(true);
  try {
    const env: NodeJS.ProcessEnv = {
      ORVYN_CLOUD_EXECUTION_PROVIDER: "vercel",
      VERCEL_CANARY_USERS: "user-admin-1",
    };
    const decision = await resolveCloudExecutionProvider(
      { userId: "user-admin-1", tenantId: "tenant-admin-1", isStaff: true },
      env
    );
    assert.equal(decision.provider, "ovh");
    assert.equal(decision.eligible, false);
  } finally {
    setEmergencyDisableVercel(false);
  }
});

test("VercelCanaryRollout: allowlisted administrator user gets Vercel Sandbox", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "canary",
    VERCEL_CANARY_USERS: "user-admin-1,user-admin-2",
    VERCEL_CANARY_ADMIN_ONLY: "true",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "user-admin-1", tenantId: "tenant-admin-1", isStaff: true },
    env
  );
  assert.equal(decision.provider, "vercel");
  assert.equal(decision.location, "VERCEL_CLOUD");
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /user allowlist/i);
});

test("VercelCanaryRollout: allowlisted non-staff user is rejected when admin-only is required", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "canary",
    VERCEL_CANARY_USERS: "user-cust-spoof",
    VERCEL_CANARY_ADMIN_ONLY: "true",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "user-cust-spoof", tenantId: "tenant-cust", isStaff: false },
    env
  );
  assert.equal(decision.provider, "ovh");
  assert.equal(decision.location, "OVH_WORKER");
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /lacks verified administrator staff authorization/i);
});

test("VercelCanaryRollout: allowlisted tenant routes to Vercel for authorized staff", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "ovh",
    VERCEL_CANARY_TENANTS: "tenant-staging-test",
    VERCEL_CANARY_ADMIN_ONLY: "true",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "user-staff", tenantId: "tenant-staging-test", isStaff: true },
    env
  );
  assert.equal(decision.provider, "vercel");
  assert.equal(decision.location, "VERCEL_CLOUD");
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /tenant allowlist/i);
});

test("VercelCanaryRollout: dynamic allowlist adds and removes users in memory", async () => {
  addCanaryUser("dynamic-admin-99");
  try {
    const env: NodeJS.ProcessEnv = {
      ORVYN_CLOUD_EXECUTION_PROVIDER: "ovh",
      VERCEL_CANARY_ADMIN_ONLY: "true",
    };
    const decision = await resolveCloudExecutionProvider(
      { userId: "dynamic-admin-99", isStaff: true },
      env
    );
    assert.equal(decision.provider, "vercel");
    assert.equal(decision.eligible, true);

    removeCanaryUser("dynamic-admin-99");
    const decisionAfter = await resolveCloudExecutionProvider(
      { userId: "dynamic-admin-99", isStaff: true },
      env
    );
    assert.equal(decisionAfter.provider, "ovh");
    assert.equal(decisionAfter.eligible, false);
  } finally {
    removeCanaryUser("dynamic-admin-99");
  }
});

test("VercelCanaryRollout: dynamic registry flag lookup activates canary for flagged project", async () => {
  const mockStore = {
    flag: async (_scope: "org" | "project", scopeId: string, flag: string) => {
      return scopeId === "proj-canary-alpha" && flag === VERCEL_CANARY_FLAG;
    },
  };
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "canary",
    VERCEL_CANARY_ADMIN_ONLY: "true",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "staff-1", projectId: "proj-canary-alpha", isStaff: true },
    env,
    mockStore
  );
  assert.equal(decision.provider, "vercel");
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /project registry flag/i);
});

test("VercelCanaryRollout: broad rollout mode enables Vercel without canary checks", async () => {
  const env: NodeJS.ProcessEnv = {
    ORVYN_CLOUD_EXECUTION_PROVIDER: "vercel",
    VERCEL_CANARY_REQUIRED: "false",
  };
  const decision = await resolveCloudExecutionProvider(
    { userId: "any-user", tenantId: "any-tenant", isStaff: false },
    env
  );
  assert.equal(decision.provider, "vercel");
  assert.equal(decision.location, "VERCEL_CLOUD");
  assert.equal(decision.eligible, true);
});
