import { test } from "node:test";
import assert from "node:assert/strict";
import { inferTaskIntent } from "../agent/taskIntent";
import { laneModel } from "./certifiedModels";
import { selectAgentModel, selectImageModel } from "./selectModel";

const ids = [
  laneModel("fast").registryId,
  laneModel("fast-secondary").registryId,
  laneModel("auto").registryId,
  laneModel("engineering").registryId,
  laneModel("frontend").registryId,
  laneModel("premium").registryId,
  laneModel("image").registryId,
  laneModel("image-quality").registryId,
];

test("routine auto coding uses DeepSeek V4.1 Flash, not GLM-5.3", () => {
  const intent = inferTaskIntent("Fix the failing test.");
  const choice = selectAgentModel({ intent, composerMode: "auto", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("auto").registryId);
  assert.equal(choice.lane, "auto");
});

test("code, server, and long-horizon work use GLM-5.3", () => {
  const intent = inferTaskIntent("Refactor the auth module across the repo.");
  const choice = selectAgentModel({ intent, composerMode: "code", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("engineering").registryId);
});

test("a website build uses Kimi K2.7 Code", () => {
  const intent = inferTaskIntent("Build a polished responsive SaaS landing page and show it to me.");
  assert.equal(intent.requiresFrontend, true);
  assert.equal(intent.requiresBrowserVerification, true);
  const choice = selectAgentModel({ intent, composerMode: "auto", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("frontend").registryId);
});

test("a pinned model is not replaced", () => {
  const intent = inferTaskIntent("Build a responsive dashboard and show it.");
  const choice = selectAgentModel({
    intent,
    requestedModelId: "ci:gpt-5.6-luna",
    availableIds: ids,
  });
  assert.equal(choice.pinned, true);
  assert.equal(choice.registryId, "ci:gpt-5.6-luna");
});

test("simple questions stay on the fast lane", () => {
  const intent = inferTaskIntent("What is a closure in JavaScript?");
  const choice = selectAgentModel({ intent, requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("fast").registryId);
});

test("escalation moves Auto to GLM-5.3 and then stops at premium", () => {
  const intent = inferTaskIntent("Fix the failing test.");
  const once = selectAgentModel({ intent, requestedModelId: "auto", availableIds: ids, escalate: 1 });
  assert.equal(once.registryId, laneModel("engineering").registryId);
  const twice = selectAgentModel({ intent, requestedModelId: "auto", availableIds: ids, escalate: 2 });
  assert.equal(twice.registryId, laneModel("premium").registryId);
});

test("an unhealthy Auto model is skipped", () => {
  const intent = inferTaskIntent("Fix the failing test.");
  const choice = selectAgentModel({
    intent,
    requestedModelId: "auto",
    availableIds: ids,
    health: [{ registryId: laneModel("auto").registryId, failureRate: 0.8 }],
  });
  assert.equal(choice.registryId, laneModel("engineering").registryId);
});

test("image quality and edits stay on Kontext models", () => {
  const normal = selectImageModel({ quality: "medium", availableIds: ids });
  assert.equal(normal.registryId, laneModel("image").registryId);
  const premium = selectImageModel({ quality: "premium", availableIds: ids });
  assert.equal(premium.registryId, laneModel("image-quality").registryId);
  const textOnly = selectImageModel({
    editing: true,
    requestedModelId: laneModel("auto").registryId,
    availableIds: ids,
  });
  assert.equal(textOnly.registryId, null);
});
