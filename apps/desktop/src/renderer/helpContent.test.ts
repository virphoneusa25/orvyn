import { test } from "node:test";
import assert from "node:assert/strict";
import { filterHelpTopics, HELP_TOPICS } from "./helpContent.ts";

test("help covers the required getting-started topics", () => {
  const ids = HELP_TOPICS.map((t) => t.id);
  for (const id of [
    "what",
    "mission",
    "modes",
    "models",
    "reasoning",
    "permissions",
    "workspace",
    "terminal",
    "browser",
    "approve",
    "stop",
    "queue",
    "files",
    "cloud",
    "shortcuts",
    "update",
  ]) {
    assert.ok(ids.includes(id), `missing help topic ${id}`);
  }
});

test("help search filters by title, tags, and body", () => {
  assert.ok(filterHelpTopics(HELP_TOPICS, "permissions").some((t) => t.id === "permissions"));
  assert.ok(filterHelpTopics(HELP_TOPICS, "terminal").some((t) => t.id === "terminal"));
  assert.ok(filterHelpTopics(HELP_TOPICS, "cloud").some((t) => t.id === "cloud"));
  assert.ok(filterHelpTopics(HELP_TOPICS, "models").some((t) => t.id === "models"));
  assert.ok(filterHelpTopics(HELP_TOPICS, "missions").some((t) => t.id === "mission"));
  assert.equal(filterHelpTopics(HELP_TOPICS, "xyz-not-a-topic").length, 0);
});

test("help copy does not expose internal secrets or config keys", () => {
  const blob = HELP_TOPICS.map((t) => t.body).join("\n");
  assert.equal(/ORVYN_API_KEY|orvsess_|safeStorage|BEGIN PRIVATE/.test(blob), false);
});
