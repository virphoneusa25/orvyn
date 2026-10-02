// Turn-routing and resource-gating contract: one user turn has exactly one
// response owner, and resource resolution is only authoritative when the
// intent explicitly requires that resource. These are the regression cases
// for the "a greeting produced a run and a 'no server connected' error" bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inferTaskIntent } from "./taskIntent";
import { routeTurn } from "./turnRouting";
import { decideTurn } from "@orvyn/ai-core";
import { externalResourceRequired, resolveResources, type RegisteredResource } from "./resourceResolver";

const SCOPE = { tenantId: "t1", organizationId: "o1", projectId: null as string | null };

function resolve(instruction: string, resources: RegisteredResource[] = [], composerMode = "auto") {
  return resolveResources({
    intent: inferTaskIntent(instruction, composerMode),
    instruction,
    ...SCOPE,
    resources,
  });
}

const SERVER: RegisteredResource = {
  resourceId: "server:prod",
  tenantId: "t1",
  organizationId: "o1",
  authorized: true,
  projectId: null,
  type: "server",
  capabilities: ["remoteShell"],
  status: "ready",
  labels: ["prod"],
};

test("a greeting is a chat turn: no run, no resolution, no resource card", () => {
  const intent = inferTaskIntent("Hi", "auto");
  assert.equal(intent.informational, true);
  assert.equal(intent.executionComplexity, "answer");
  assert.equal(routeTurn("Hi", "auto"), "chat");
  assert.equal(externalResourceRequired(intent), false);
  assert.equal(resolve("Hi").status, "ok");
});

test("capability questions are chat turns", () => {
  for (const q of ["What can you do?", "How do I configure nginx?", "Explain how the queue works"]) {
    assert.equal(routeTurn(q, "auto"), "chat", q);
    assert.equal(resolve(q).status, "ok", q);
  }
});

test("text-only requests stay in chat even when phrased as actions", () => {
  for (const q of ["Write an email", "Draft a thank-you note", "?"]) {
    assert.equal(routeTurn(q, "auto"), "chat", q);
  }
});

test("an informational question naming a resource never blocks on it", () => {
  // "How do I query postgres?" classifies as database category, but it asks
  // for an answer — not a database connection.
  const res = resolve("How do I query a postgres database?");
  assert.equal(res.status, "ok");
});

test("an explicit server task without a connected server blocks truthfully", () => {
  const res = resolve("Check nginx on my server");
  assert.equal(res.status, "blocked");
  if (res.status === "blocked") {
    assert.equal(res.code, "RESOURCE_REQUIRED");
    assert.equal(res.resourceType, "server");
  }
});

test("an explicit server task resolves the connected server", () => {
  const res = resolve("Check nginx on my prod server", [SERVER]);
  assert.equal(res.status, "ok");
  if (res.status === "ok") assert.equal(res.resources[0]?.resourceId, "server:prod");
});

test("workspace coding work never requires a server", () => {
  const res = resolve("Build me a React login page");
  assert.equal(res.status, "ok");
});

test("a frontend task that names a remote target still requires it", () => {
  const res = resolve("Deploy my website to my server");
  assert.equal(res.status, "blocked");
  if (res.status === "blocked") assert.equal(res.resourceType, "server");
});

test("GitHub read-only inspection does not require SSH", () => {
  const q = "read-only access to inspect a GitHub repository's code, issues, tests, and configuration";
  const intent = inferTaskIntent(q);
  assert.equal(intent.requiresGitHub, true);
  assert.equal(intent.requiresRemoteResource, false);
  assert.equal(intent.resourceRequirements.includes("server"), false);
  const workerOnly: RegisteredResource = {
    resourceId: "worker:1",
    tenantId: "t1",
    organizationId: "o1",
    authorized: true,
    projectId: null,
    type: "cloud_worker",
    capabilities: ["sandbox"],
    status: "ready",
    labels: ["worker"],
  };
  const res = resolve(q, [workerOnly]);
  assert.equal(res.status, "ok");
});

test("explicit SSH task requires a server; a cloud worker is not a server", () => {
  const res = resolve("SSH into my server and inspect nginx", [
    {
      resourceId: "worker:1",
      tenantId: "t1",
      organizationId: "o1",
      authorized: true,
      projectId: null,
      type: "cloud_worker",
      capabilities: ["sandbox"],
      status: "ready",
      labels: ["worker"],
    },
  ]);
  assert.equal(res.status, "blocked");
  if (res.status === "blocked") assert.equal(res.resourceType, "server");
});

test("a missing unrelated resource cannot block a coding task", () => {
  const intent = inferTaskIntent("Build me a React login page");
  assert.equal(intent.resourceRequirements.includes("server"), false);
  assert.equal(resolve("Build me a React login page").status, "ok");
});

test("browser tasks require the browser capability, not SSH", () => {
  const intent = inferTaskIntent("Open the website homepage in the browser");
  assert.equal(intent.requiresBrowser, true);
  assert.equal(intent.requiresRemoteResource, false);
});

test("action prompts are run turns", () => {
  for (const q of ["Check nginx on my server", "Build me a React login page", "Deploy this", "Fix the login page on my connected server"]) {
    assert.equal(routeTurn(q, "auto"), "run", q);
  }
});

test("a capability question about an active ad answers without image or agent work", () => {
  const question = decideTurn("Can you use icons in the ad?", { activeArtifactId: "artifact-ad-1", hasPreviousExecution: true });
  assert.equal(question.disposition, "answer");
  assert.equal(question.requiresTool, false);
  assert.equal(question.targetArtifactId, "artifact-ad-1");
  assert.equal(question.responseOwner, "conversation");
  assert.equal(routeTurn("Can you use icons in the ad?", "auto"), "chat");
  assert.equal(decideTurn("Can you use this logo for VirPhone?", { hasAttachments: true }).requiresExecution, true);
});

test("an explicit artifact edit and a failed-task follow-up execute with continuity", () => {
  const edit = decideTurn("Add recycling icons to the ad.", { activeArtifactId: "artifact-ad-1" });
  assert.equal(edit.disposition, "edit_existing");
  assert.equal(edit.targetArtifactId, "artifact-ad-1");
  assert.equal(routeTurn("Add recycling icons to the ad."), "run");

  const retry = decideTurn("That didn't fix it.", { activeProjectId: "project-1", activeMissionId: "run-1", hasPreviousExecution: true });
  assert.equal(retry.disposition, "continue_execution");
  assert.equal(retry.targetMissionId, "run-1");
  assert.equal(retry.responseOwner, "single_agent");
  assert.equal(routeTurn("That didn't fix it.", "auto", { activeProjectId: "project-1", activeMissionId: "run-1", hasPreviousExecution: true }), "run");
});

test("question and action forms of the same nginx request have different dispositions", () => {
  assert.equal(decideTurn("How do I configure nginx?").disposition, "answer");
  assert.equal(routeTurn("How do I configure nginx?"), "chat");
  assert.equal(decideTurn("Configure nginx on my connected server.").disposition, "execute");
  assert.equal(routeTurn("Configure nginx on my connected server."), "run");
});
