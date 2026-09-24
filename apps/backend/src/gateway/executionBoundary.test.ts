import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudFilesystemDecision } from "./executionBoundary";

test("a cloud run cannot write a Windows or host path, or leave the workspace", () => {
  const deny = cloudFilesystemDecision("cloud_worker", "C:\\Users\\a\\site.html", "/cloud/ws");
  assert.equal(deny.ok, false);
  if (!deny.ok) assert.equal(deny.code, "CROSS_EXECUTION_BOUNDARY");
  assert.equal(cloudFilesystemDecision("cloud_worker", "/home/ubuntu/x", "/cloud/ws").ok, false);
  assert.equal(cloudFilesystemDecision("cloud_worker", "../../outside", "/cloud/ws").ok, false);
  const allow = cloudFilesystemDecision("cloud_worker", "src/App.tsx", "/cloud/ws");
  assert.equal(allow.ok, true);
  assert.equal(cloudFilesystemDecision("local_host", "C:\\Users\\a\\site.html", "/cloud/ws").ok, true);
});
