import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBuildRepair, emptyWebsiteMission, failureFingerprint, isBuildCommand, isWebsiteImplementation, syncWebsitePhase, websiteActionPrompt, websiteEvidenceFrom } from "./websiteMission";

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

test("a website build is not the same as writing a file named index.html", () => {
  assert.equal(isWebsiteImplementation("Build a simple one-page website with a hero, services, and contact section."), true);
  assert.equal(isWebsiteImplementation("Create index.html containing Hello World."), false);
});

test("a website moves inspect, write, preview, then browser before it is complete", () => {
  const mission = emptyWebsiteMission();
  assert.equal(syncWebsitePhase(mission, websiteEvidenceFrom([])), "planning");
  assert.match(websiteActionPrompt("planning"), /list_directory/);
  const inspected = syncWebsitePhase(mission, websiteEvidenceFrom([
    { type: "tool.completed", data: { tool: "list_directory" } },
  ]));
  assert.equal(inspected, "implementing");
  assert.match(websiteActionPrompt(inspected), /write_file/);
  const wrote = syncWebsitePhase(mission, websiteEvidenceFrom([
    { type: "tool.completed", data: { tool: "list_directory" } },
    { type: "file.created", data: { path: "index.html" } },
  ]));
  assert.equal(wrote, "starting");
  const served = syncWebsitePhase(mission, websiteEvidenceFrom([
    { type: "file.created", data: { path: "index.html" } },
    { type: "preview.available", data: { url: "https://preview.example/s/1" } },
  ]));
  assert.equal(served, "browser_verification");
  assert.match(websiteActionPrompt(served), /browser_open/);
  const done = syncWebsitePhase(mission, websiteEvidenceFrom([
    { type: "file.created", data: { path: "index.html" } },
    { type: "preview.available", data: { url: "https://preview.example/s/1" } },
    { type: "browser.completed", data: { tool: "browser_screenshot" } },
  ]));
  assert.equal(done, "completed");
});

test("build commands and fingerprints are stable", () => {
  assert.equal(isBuildCommand("npm run build"), true);
  assert.equal(isBuildCommand("ls"), false);
  assert.equal(failureFingerprint("noise\nerror TS2304: Cannot find name Foo\n"), "error TS2304: Cannot find name Foo");
});
