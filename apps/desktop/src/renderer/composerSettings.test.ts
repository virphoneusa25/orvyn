// apps/desktop/src/renderer/composerSettings.test.ts
//
// Shared composer settings model — the same defaults feed BOTH the Home
// "new mission" composer and the chat composer, and the same fields flow
// into the run payload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readComposerDefaults, toRunPayloadSettings, COMPOSER_MODES } from "./composerSettings.ts";

function storeOf(entries: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (k: string) => (k in entries ? entries[k] : null) };
}

test("defaults: nothing stored → Auto model/reasoning, Auto Read access, auto mode", () => {
  const d = readComposerDefaults(storeOf({}));
  assert.deepEqual(d, { modelId: "auto", reasoningEffort: "auto", permissionMode: "auto_read", mode: "auto" });
});

test("defaults: stored user defaults are honored (same keys as chat)", () => {
  const d = readComposerDefaults(storeOf({
    "orvyn:run-model": "ci:glm-5.3",
    "orvyn:reasoning": "deep",
    "orvyn:access": "full_access",
    "orvyn:composer-mode": "server",
  }));
  assert.equal(d.modelId, "ci:glm-5.3");
  assert.equal(d.reasoningEffort, "deep");
  assert.equal(d.permissionMode, "full_access");
  assert.equal(d.mode, "server");
});

test("defaults: garbage values fall back to Auto/Auto Read, never crash", () => {
  const d = readComposerDefaults(storeOf({
    "orvyn:reasoning": "ultra",
    "orvyn:access": "yolo",
    "orvyn:composer-mode": "",
  }));
  assert.equal(d.reasoningEffort, "auto");
  assert.equal(d.permissionMode, "auto_read");
  assert.equal(d.mode, "auto");
});

test("payload: composer selections map 1:1 onto the run payload fields", () => {
  assert.deepEqual(
    toRunPayloadSettings({ modelId: "ci:glm-5.3", reasoningEffort: "deep", permissionMode: "auto_workspace" }),
    { requestedModelId: "ci:glm-5.3", reasoningEffort: "deep", permissionMode: "auto_workspace" }
  );
});

test("payload: empty settings carry nothing (backend defaults apply)", () => {
  assert.deepEqual(toRunPayloadSettings(undefined), {});
  assert.deepEqual(toRunPayloadSettings({ modelId: "  " }), { requestedModelId: undefined, reasoningEffort: undefined, permissionMode: undefined });
});

test("shared mode pills cover the six command modes with tooltips", () => {
  assert.deepEqual(COMPOSER_MODES.map((m) => m.id), ["auto", "code", "server", "research", "deploy", "automate"]);
  for (const m of COMPOSER_MODES) assert.ok(m.title.length > 3, `${m.id} has a tooltip`);
});
