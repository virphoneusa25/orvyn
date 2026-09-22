import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeSocket, resolveTenant } from "./tenant";

function mockRes() {
  return {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function runResolve(key?: string) {
  const req = {
    tenant: undefined as unknown,
    header(name: string) {
      if (name === "authorization" && key) return `Bearer ${key}`;
      return undefined;
    },
    query: {},
  };
  const res = mockRes();
  let next = false;
  resolveTenant(req as never, res as never, () => {
    next = true;
  });
  return { req, res, next };
}

test("cloud mode rejects a missing credential instead of the local default tenant", () => {
  const prev = process.env.ORVYN_CLOUD_MODE;
  process.env.ORVYN_CLOUD_MODE = "true";
  try {
    const { req, res, next } = runResolve();
    assert.equal(next, false);
    assert.equal(res.statusCode, 401);
    assert.equal(req.tenant, undefined);
    const socket = authorizeSocket(null);
    assert.equal(socket.ok, false);
    const bad = authorizeSocket("orvsess_not-a-real-session");
    assert.equal(bad.ok, false);
  } finally {
    if (prev === undefined) delete process.env.ORVYN_CLOUD_MODE;
    else process.env.ORVYN_CLOUD_MODE = prev;
  }
});

test("local mode still admits the default tenant when no keys are registered", () => {
  const prev = process.env.ORVYN_CLOUD_MODE;
  delete process.env.ORVYN_CLOUD_MODE;
  try {
    const { req, res, next } = runResolve();
    assert.equal(next, true);
    assert.equal(res.statusCode, 0);
    assert.equal((req.tenant as { id?: string } | undefined)?.id, "default");
    const socket = authorizeSocket(null);
    assert.equal(socket.ok, true);
    if (socket.ok) assert.equal(socket.tenant.id, "default");
  } finally {
    if (prev === undefined) delete process.env.ORVYN_CLOUD_MODE;
    else process.env.ORVYN_CLOUD_MODE = prev;
  }
});
