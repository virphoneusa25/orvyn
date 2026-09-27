import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAvailablePreviewCommand } from "./processTools";

test("a busy web preview port gets one bounded available replacement", async () => {
  const selected = await chooseAvailablePreviewCommand("npx --yes http-server -p 8080 -c-1", async (port) => port === 8080 || port === 8081);
  assert.equal(selected.command, "npx --yes http-server -p 8082 -c-1");
  assert.equal(selected.changedFrom, 8080);
  assert.equal(selected.port, 8082);
});

test("an available port and unrelated commands are preserved", async () => {
  assert.equal((await chooseAvailablePreviewCommand("vite --port 5173", async () => false)).command, "vite --port 5173");
  assert.equal((await chooseAvailablePreviewCommand("node server.js --port 8080", async () => true)).command, "node server.js --port 8080");
});
