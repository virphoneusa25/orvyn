import { test } from "node:test";
import assert from "node:assert/strict";
import { accountGateEnabled, gateExempt } from "./accountReady";

test("the account gate is on for ORVYN Cloud and can only be turned off explicitly", () => {
  assert.equal(accountGateEnabled({ ORVYN_CLOUD_MODE: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(accountGateEnabled({ ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_ONBOARDING: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(accountGateEnabled({} as NodeJS.ProcessEnv), false, "a local engine has no accounts to gate");
});

test("only worker channels and read-only setup status pass the gate", () => {
  assert.equal(gateExempt("GET", "/billing"), true);
  assert.equal(gateExempt("POST", "/billing/checkout"), false);
  assert.equal(gateExempt("POST", "/local-worker/register"), true);
  assert.equal(gateExempt("GET", "/worker/list"), true);
  assert.equal(gateExempt("GET", "/workers-evil"), false);
  assert.equal(gateExempt("GET", "/projects"), false);
  assert.equal(gateExempt("POST", "/agent/stream/runs"), false);
  assert.equal(gateExempt("GET", "/documents/list"), false);
});
