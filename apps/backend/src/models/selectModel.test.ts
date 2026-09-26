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

const withSonnet = [...ids, laneModel("premium-alt").registryId];

test("coding work starts on Kimi K2.7 Code (the code agent), not GLM or premium", () => {
  for (const [text, mode] of [["Fix the failing test.", "auto"], ["Refactor the auth module across the repo.", "code"]] as const) {
    const choice = selectAgentModel({ intent: inferTaskIntent(text), composerMode: mode, requestedModelId: "auto", availableIds: ids });
    assert.equal(choice.registryId, laneModel("frontend").registryId, text);
    assert.equal(choice.lane, "code");
    assert.equal(choice.route?.profile, "code");
  }
});

test("routine non-coding agent work uses the cheap Auto model", () => {
  const choice = selectAgentModel({ intent: inferTaskIntent("Create hello.txt with the text hi"), composerMode: "auto", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("auto").registryId);
  assert.equal(choice.lane, "auto");
});

test("a website build uses Kimi K2.7 Code", () => {
  const intent = inferTaskIntent("Build a polished responsive SaaS landing page and show it to me.");
  assert.equal(intent.requiresFrontend, true);
  assert.equal(intent.requiresBrowserVerification, true);
  const choice = selectAgentModel({ intent, composerMode: "auto", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("frontend").registryId);
});

test("server work uses the server profile; without Gemini registered it starts on GLM-5.3", () => {
  const choice = selectAgentModel({ intent: inferTaskIntent("Why is nginx returning 502 on my server?"), composerMode: "server", requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.route?.profile, "server");
  assert.equal(choice.registryId, laneModel("engineering").registryId);
  const gemini = selectAgentModel({ intent: inferTaskIntent("Why is nginx returning 502 on my server?"), composerMode: "server", requestedModelId: "auto", availableIds: [...ids, "gemini:gemini-3.8-flash"] });
  assert.equal(gemini.registryId, "gemini:gemini-3.8-flash");
});

test("a pinned model is not replaced", () => {
  const intent = inferTaskIntent("Build a responsive dashboard and show it.");
  const choice = selectAgentModel({ intent, requestedModelId: "ci:gpt-5.6-luna", availableIds: ids });
  assert.equal(choice.pinned, true);
  assert.equal(choice.registryId, "ci:gpt-5.6-luna");
});

test("simple questions stay on the fast utility tier", () => {
  const intent = inferTaskIntent("What is a closure in JavaScript?");
  const choice = selectAgentModel({ intent, requestedModelId: "auto", availableIds: ids });
  assert.equal(choice.registryId, laneModel("fast").registryId);
});

test("escalation climbs Kimi → GLM-5.3 → Claude Sonnet 5, never to GPT-5.6 Sol by itself", () => {
  const intent = inferTaskIntent("Build a polished responsive SaaS landing page and show it to me.");
  const at = (n: number) => selectAgentModel({ intent, requestedModelId: "auto", availableIds: withSonnet, escalate: n }).registryId;
  assert.equal(at(0), laneModel("frontend").registryId);
  assert.equal(at(1), laneModel("engineering").registryId);
  assert.equal(at(2), laneModel("premium-alt").registryId);
  assert.equal(at(3), laneModel("premium-alt").registryId, "the top of the ladder stays put");
  assert.notEqual(at(5), laneModel("premium").registryId);
});

test("an unhealthy model is skipped", () => {
  const intent = inferTaskIntent("Create hello.txt with the text hi");
  const choice = selectAgentModel({ intent, requestedModelId: "auto", availableIds: ids, health: [{ registryId: laneModel("auto").registryId, failureRate: 0.8 }] });
  assert.equal(choice.registryId, laneModel("engineering").registryId, "Auto → (agent tier shares the unhealthy model) → heavy");
});

test("Premium (requested) puts GPT-5.6 Sol first", () => {
  const choice = selectAgentModel({ intent: inferTaskIntent("Fix the failing test."), requestedModelId: "premium", availableIds: withSonnet });
  assert.equal(choice.registryId, laneModel("premium").registryId);
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
  const catalogOnly = selectImageModel({
    availableIds: ["ci:catalog-image"],
    catalog: [{ registryId: "ci:catalog-image", generation: true, editing: false }],
  });
  assert.equal(catalogOnly.registryId, "ci:catalog-image");
  const cannotEdit = selectImageModel({
    editing: true,
    availableIds: ["ci:catalog-image"],
    catalog: [{ registryId: "ci:catalog-image", generation: true, editing: false }],
  });
  assert.equal(cannotEdit.registryId, null);
});

test("a thinking-heavy task goes to a strong reasoning model (not Sol by default); a pinned model still wins", () => {
  const intent = inferTaskIntent("What should we name our foundation model family?", "auto");
  const deep = selectAgentModel({ intent, composerMode: "auto", requestedModelId: "auto", availableIds: [...withSonnet, "gemini:gemini-3.8-flash"], deep: true });
  assert.equal(deep.registryId, "gemini:gemini-3.8-flash", "Gemini 3.8 Flash first for deep questions");
  const noGemini = selectAgentModel({ intent, composerMode: "auto", requestedModelId: "auto", availableIds: withSonnet, deep: true });
  assert.equal(noGemini.registryId, laneModel("premium-alt").registryId, "then Claude Sonnet 5 — GPT-5.6 Sol is not the default");
  const pinned = selectAgentModel({ intent, composerMode: "auto", requestedModelId: laneModel("fast").registryId, availableIds: ids, deep: true });
  assert.equal(pinned.registryId, laneModel("fast").registryId);
});
