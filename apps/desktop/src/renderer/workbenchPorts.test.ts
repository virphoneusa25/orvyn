import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPort,
  detectPortsFromText,
  isAutoForwardCandidate,
  isBlockedInfrastructurePort,
  mergeDetectedPorts,
} from "./workbenchPorts.ts";

test("classifies web, internal, and unknown ports", () => {
  assert.equal(classifyPort(5173, "vite"), "development_server");
  assert.equal(classifyPort(5432), "internal_service");
  assert.equal(classifyPort(6379, "redis-server"), "internal_service");
  assert.equal(isAutoForwardCandidate(classifyPort(5173, "vite"), 5173), true);
  assert.equal(isAutoForwardCandidate(classifyPort(5432), 5432), false);
  assert.equal(isBlockedInfrastructurePort(4570), true);
});

test("detects listening preview ports from process output", () => {
  const ports = detectPortsFromText("  ➜  Local:   http://localhost:5173/\nready", "cloud");
  assert.equal(ports.length, 1);
  assert.equal(ports[0]!.port, 5173);
  assert.equal(ports[0]!.classification, "development_server");
});

test("stale ports become inactive when the service disappears", () => {
  const merged = mergeDetectedPorts(
    [{ port: 5173, environment: "cloud", classification: "web_preview", status: "forwarded" }],
    [{ port: 5173, environment: "cloud", classification: "web_preview", status: "inactive" }]
  );
  assert.equal(merged[0]!.status, "inactive");
});
