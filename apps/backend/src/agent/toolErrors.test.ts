import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityUnavailableError,
  classifyToolError,
  FatalToolError,
  FixableToolError,
  PermissionToolError,
  PolicyToolError,
  recoveryFor,
  RetryableToolError,
  WorkspaceToolError,
} from "./toolErrors";

test("BAD_ARGS maps to a fixable error, repairable once", () => {
  const err = classifyToolError({ tool: "write_file", error: "missing: path, content", errorType: "INVALID_ARGUMENTS", missing: ["path", "content"] });
  assert.ok(err instanceof FixableToolError);
  assert.equal(err.toolErrorClass, "fixable");
  assert.equal(err.retryable, false);
  assert.equal(err.modelEscalation, false);
  assert.equal(recoveryFor(err).action, "repair_arguments");
});

test("a timeout maps to retryable with backoff", () => {
  const err = classifyToolError({ tool: "fetch_url", error: "request timed out after 30s", errorType: "TIMEOUT" });
  assert.ok(err instanceof RetryableToolError);
  const recovery = recoveryFor(err);
  assert.equal(recovery.action, "retry_backoff");
  if (recovery.action === "retry_backoff") {
    assert.ok(recovery.maxAttempts > 0);
    assert.ok(recovery.retryAfterMs > 0);
  }
});

test("429 and transient network failures are retryable", () => {
  for (const text of ["HTTP 429 rate limit", "ECONNRESET", "socket hang up", "503 temporarily unavailable"]) {
    const err = classifyToolError({ tool: "web_search", error: text });
    assert.ok(err instanceof RetryableToolError, text);
    assert.equal(recoveryFor(err).action, "retry_backoff");
  }
});

test("permission denied is never retried and never escalates the model", () => {
  const err = classifyToolError({ tool: "write_file", error: "EACCES: permission denied", errorType: "PERMISSION_DENIED" });
  assert.ok(err instanceof PermissionToolError);
  assert.equal(err.retryable, false);
  assert.equal(err.modelEscalation, false);
  assert.equal(recoveryFor(err).action, "request_permission");
});

test("sandbox policy denials are a policy class, not a model problem", () => {
  const err = classifyToolError({ tool: "ssh_exec", error: "NETWORK_POLICY_DENIED: host not allowed" });
  assert.ok(err instanceof PolicyToolError);
  assert.equal(recoveryFor(err).action, "request_permission");
});

test("a missing workspace path is a workspace error, not a fatal crash", () => {
  const err = classifyToolError({ tool: "read_file", error: "ENOENT: no such file or directory", errorType: "RESOURCE_MISSING" });
  assert.ok(err instanceof WorkspaceToolError);
  assert.equal(recoveryFor(err).action, "resolve_workspace");
});

test("an unknown tool asks for an equivalent capability, not a retry", () => {
  const err = classifyToolError({ tool: "fly_deploy", error: 'There is no tool named "fly_deploy" in this run.', errorType: "CAPABILITY_UNAVAILABLE" });
  assert.ok(err instanceof CapabilityUnavailableError);
  assert.equal(recoveryFor(err).action, "select_alternative");
});

test("an unclassified executed failure stops that path", () => {
  const err = classifyToolError({ tool: "terminal", error: "segmentation fault" });
  assert.ok(err instanceof FatalToolError);
  assert.equal(recoveryFor(err).action, "stop_path");
});

test("no tool error class permits model escalation", () => {
  for (const text of ["missing args", "timed out", "EACCES", "ENOENT", "no tool named x", "crashed"]) {
    const err = classifyToolError({ tool: "t", error: text });
    assert.equal(err.modelEscalation, false, text);
  }
});
