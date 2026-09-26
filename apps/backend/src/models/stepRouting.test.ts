import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptHelperStep, helperFor, isReadOnlyCall, shouldUseHelper } from "./stepRouting";
import { startRoute } from "./routingPolicy";

const ids = ["fw:accounts/fireworks/models/kimi-k2p7-code", "fw:accounts/fireworks/models/glm-5p3", "mistral:codestral-25-08", "openrouter:deepseek/deepseek-v3.2", "gemini:gemini-3.8-flash", "fw:accounts/fireworks/models/deepseek-v4p1-flash"];

test("read-only calls: read tools and read-only commands (terminal and SSH)", () => {
  assert.equal(isReadOnlyCall("read_file", { path: "a" }), true);
  assert.equal(isReadOnlyCall("ssh_exec", { host: "prod", command: "journalctl -u nginx -n 200" }), true);
  assert.equal(isReadOnlyCall("ssh_exec", { host: "prod", command: "systemctl restart nginx" }), false);
  assert.equal(isReadOnlyCall("write_file", { path: "a" }), false);
  assert.equal(isReadOnlyCall("terminal", { command: "npm test" }), false);
});

test("a helper takes look-around steps on the Code and Server agents only, after two look-only batches", () => {
  const code = startRoute({ profile: "code", instruction: "Build the settings page", availableIds: ids });
  const server = startRoute({ profile: "server", instruction: "nginx 502", availableIds: ids });
  assert.equal(helperFor(code, code.registryId!, ids), "mistral:codestral-25-08");
  assert.equal(helperFor(server, server.registryId!, ids), "openrouter:deepseek/deepseek-v3.2");
  assert.equal(shouldUseHelper({ route: code, readOnlyStreak: 2, helperRejects: 0, currentModelId: code.registryId!, pinned: false }), true);
  assert.equal(shouldUseHelper({ route: code, readOnlyStreak: 1, helperRejects: 0, currentModelId: code.registryId!, pinned: false }), false);
  assert.equal(shouldUseHelper({ route: code, readOnlyStreak: 3, helperRejects: 2, currentModelId: code.registryId!, pinned: false }), false, "gives up after two rejected steps");
  assert.equal(shouldUseHelper({ route: code, readOnlyStreak: 3, helperRejects: 0, currentModelId: code.registryId!, pinned: true }), false);
  const auto = startRoute({ profile: "auto", instruction: "x", availableIds: ids });
  assert.equal(shouldUseHelper({ route: auto, readOnlyStreak: 5, helperRejects: 0, currentModelId: auto.registryId!, pinned: false }), false, "Auto is already cheap");
});

test("a helper step is kept only when every call just looks", () => {
  assert.equal(acceptHelperStep([{ name: "read_file", arguments: { path: "a" } }, { name: "ssh_exec", arguments: { host: "p", command: "df -h" } }]), true);
  assert.equal(acceptHelperStep([{ name: "read_file" }, { name: "edit_file" }]), false);
  assert.equal(acceptHelperStep([]), false, "a final answer comes from the main model");
});
