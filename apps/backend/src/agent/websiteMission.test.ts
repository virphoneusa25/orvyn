import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBuildRepair, emptyWebsiteMission, failureFingerprint, isBuildCommand } from "./websiteMission";

test("the first build failure stays on the current model", () => {
  const d = decideBuildRepair(emptyWebsiteMission(), "error TS2322");
  assert.equal(d.escalate, 0);
  assert.equal(d.budgetExceeded, false);
  assert.equal(d.phase, "repairing_build");
});

test("the same compiler error twice escalates without a new mission", () => {
  const mission = emptyWebsiteMission();
  mission.buildAttempts = 1;
  mission.failures = ["error TS2322: Type string is not assignable"];
  const d = decideBuildRepair(mission, "error TS2322: Type string is not assignable");
  assert.equal(d.escalate, 1);
  assert.equal(d.budgetExceeded, false);
});

test("repeated build failures reach Sol and then stop", () => {
  const mission = emptyWebsiteMission();
  mission.buildAttempts = 4;
  const sol = decideBuildRepair(mission, "npm ERR! missing script");
  assert.equal(sol.escalate, 2);
  mission.buildAttempts = 6;
  const stop = decideBuildRepair(mission, "npm ERR! missing script");
  assert.equal(stop.budgetExceeded, true);
});

test("build commands and fingerprints are stable", () => {
  assert.equal(isBuildCommand("npm run build"), true);
  assert.equal(isBuildCommand("ls"), false);
  assert.equal(failureFingerprint("noise\nerror TS2304: Cannot find name Foo\n"), "error TS2304: Cannot find name Foo");
});
