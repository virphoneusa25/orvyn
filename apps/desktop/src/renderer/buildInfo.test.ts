import { test } from "node:test";
import assert from "node:assert/strict";
import { shortBuildSha } from "./buildInfo.ts";

test("desktop build SHA shortens for the status bar", () => {
  assert.equal(shortBuildSha("dev"), "dev");
  assert.equal(shortBuildSha("adccda79eb5c1120c53e1a1a59f1be30f2d4b63a"), "adccda7");
});
