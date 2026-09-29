import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDraft, nextStep, passwordStrength, previousStep, progressSegments, recapRows, STEPS } from "./onboardingModel.ts";

test("the flow is Welcome → … → First Mission → ORVYN, with no missing step", () => {
  assert.deepEqual([...STEPS], ["welcome", "signup", "verification", "provisioning", "name", "primary_use", "goals", "work_style", "response_style", "memory", "workspace", "github", "plan", "recap", "first_mission", "complete"]);
  assert.equal(nextStep("github"), "plan");
  assert.equal(previousStep("primary_use"), "name");
  assert.equal(previousStep("name"), null, "no going back into account creation");
});

test("progress segments: done / current / future", () => {
  assert.deepEqual(progressSegments("welcome"), ["current", "future", "future", "future", "future", "future"]);
  assert.deepEqual(progressSegments("work_style"), ["done", "done", "current", "future", "future", "future"]);
  assert.deepEqual(progressSegments("first_mission"), ["done", "done", "done", "done", "done", "current"]);
});

test("recap rows show the answers and Edit returns to the right step", () => {
  const rows = recapRows({ name: "Royce", primaryUse: ["software", "devops"], goals: ["build_software", "other"], goalOther: "VoIP billing", workStyle: "adaptive", responseStyle: "concise", memory: true, workspace: { choice: "new_project" } }, { githubConnected: true });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.primary_use!.value, "Software Development, Server / DevOps");
  assert.equal(byKey.goals!.value, "Build software faster, VoIP billing");
  assert.equal(byKey.response_style!.value, "Concise");
  assert.equal(byKey.github!.value, "Connected");
  assert.equal(byKey.work_style!.step, "work_style");
  assert.equal(byKey.memory!.step, "memory");
});

test("password strength", () => {
  assert.equal(passwordStrength("short").ok, false);
  assert.equal(passwordStrength("longenough").ok, true);
  assert.equal(passwordStrength("Longer-Pass-2026!").label, "Strong");
});

test("an offline draft keeps the user's answers but never skips verification", () => {
  const profile = { id: "p", currentStep: "goals" as const, completedSteps: ["name" as const], answers: { name: "Royce" }, completedAt: null, updatedAt: 1000 };
  const merged = mergeDraft(profile, { step: "work_style", answers: { goals: ["research"] }, completed: ["goals"], savedAt: 2000 });
  assert.equal(merged.step, "work_style");
  assert.deepEqual(merged.answers, { name: "Royce", goals: ["research"] });
  assert.equal(merged.needsSync, true);
  const locked = mergeDraft({ ...profile, currentStep: "verification" }, { step: "memory", answers: {}, completed: [], savedAt: 3000 });
  assert.equal(locked.step, "verification");
  const stale = mergeDraft(profile, { step: "memory", answers: { name: "Old" }, completed: [], savedAt: 500 });
  assert.equal(stale.step, "goals");
  assert.equal(stale.needsSync, false);
});

test("the account gate: no session, no ORVYN", async () => {
  const { decideGate, gateAfterAccountChange } = await import("./onboardingModel.ts");
  assert.equal(decideGate({ bypassed: false, hasSession: false, cachedComplete: false }), "new", "a fresh install signs up first");
  assert.equal(decideGate({ bypassed: false, hasSession: false, cachedComplete: true }), "new", "an existing install without an account signs in first");
  assert.equal(decideGate({ bypassed: false, hasSession: true, server: "incomplete", cachedComplete: true }), "resume", "unfinished setup resumes — no skip");
  assert.equal(decideGate({ bypassed: false, hasSession: true, server: "unauthorized", cachedComplete: true }), "new", "an expired session signs in again");
  assert.equal(decideGate({ bypassed: false, hasSession: true, server: "complete", cachedComplete: false }), "off");
  assert.equal(decideGate({ bypassed: false, hasSession: true, server: "unreachable", cachedComplete: false }), "offline", "unknown account offline never opens");
  assert.equal(decideGate({ bypassed: false, hasSession: true, server: "unreachable", cachedComplete: true }), "off", "a finished account opens offline");
  assert.equal(decideGate({ bypassed: true, hasSession: false, cachedComplete: false }), "off", "dev/test bypass only");
  assert.equal(gateAfterAccountChange("off", "signed-in", "signed-out", false), "new", "signing out returns to the gate");
  assert.equal(gateAfterAccountChange("off", "signed-in", "expired", false), "new");
  assert.equal(gateAfterAccountChange("off", "signed-out", "signed-out", false), "off", "startup state before validation does not bounce");
  assert.equal(gateAfterAccountChange("off", "signed-in", "signed-in", false), "off");
  assert.equal(gateAfterAccountChange("resume", "signed-in", "signed-out", false), "resume");
});
