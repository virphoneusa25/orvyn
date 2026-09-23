import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PortForwardingService,
  classifyPort,
  isAutoForwardCandidate,
} from "./PortForwardingService";

test("blocked infrastructure ports never auto-forward", () => {
  for (const port of [5432, 6379, 6333, 4570, 27017]) {
    assert.equal(classifyPort(port), "internal_service");
    assert.equal(isAutoForwardCandidate(classifyPort(port), port), false);
  }
});

test("vite / next ports auto-forward; unknown high ports do not", () => {
  assert.equal(classifyPort(5173, "vite"), "development_server");
  assert.equal(isAutoForwardCandidate(classifyPort(5173, "vite"), 5173), true);
  assert.equal(isAutoForwardCandidate(classifyPort(39999), 39999), false);
});

test("tenant B cannot authorize tenant A preview token", () => {
  const svc = new PortForwardingService();
  const a = svc.forward({
    tenantId: "user_a",
    userId: "a",
    environment: "cloud",
    port: 5173,
    command: "vite",
    publicBase: "https://staging.orvyn.virphoneusa.com",
  });
  assert.equal(a.status, "forwarded");
  assert.match(a.previewUrl ?? "", /\/api\/v1\/ports\/.+\/proxy\?fwd=/);
  const token = new URL(a.previewUrl!).searchParams.get("fwd")!;
  assert.throws(() => svc.authorize("user_b", a.id, token), /Not found/);
  assert.throws(() => svc.authorize("user_a", a.id, "orvport_wrong"), /Not found/);
  const rec = svc.authorize("user_a", a.id, token);
  assert.equal(rec.tenantId, "user_a");
  assert.equal(rec.port, 5173);
});

test("stop forwarding does not drop the listening row", () => {
  const svc = new PortForwardingService();
  const a = svc.forward({
    tenantId: "t",
    userId: "u",
    environment: "local",
    port: 3000,
    publicBase: "http://127.0.0.1:4570",
  });
  const stopped = svc.stop("t", a.id);
  assert.equal(stopped.status, "listening");
  assert.equal(stopped.previewUrl, undefined);
  assert.equal(svc.list("t").length, 1);
});

test("detect marks missing ports inactive and auto-forwards safe web ports", () => {
  const svc = new PortForwardingService();
  const first = svc.detect({
    tenantId: "t",
    userId: "u",
    environment: "cloud",
    ports: [{ port: 5173, command: "vite" }, { port: 5432, command: "postgres" }],
    autoForward: true,
    publicBase: "https://staging.example",
  });
  assert.equal(first.some((p) => p.port === 5432), false);
  const vite = first.find((p) => p.port === 5173)!;
  assert.equal(vite.status, "forwarded");
  const second = svc.detect({
    tenantId: "t",
    userId: "u",
    environment: "cloud",
    ports: [],
    autoForward: true,
    publicBase: "https://staging.example",
  });
  assert.equal(second.find((p) => p.port === 5173)?.status, "inactive");
});

test("cleanup is tenant and run scoped", () => {
  const svc = new PortForwardingService();
  svc.forward({ tenantId: "a", userId: "u", runId: "r1", environment: "cloud", port: 5173, publicBase: "https://x" });
  svc.forward({ tenantId: "a", userId: "u", runId: "r2", environment: "cloud", port: 3000, publicBase: "https://x" });
  svc.forward({ tenantId: "b", userId: "u", runId: "r1", environment: "cloud", port: 5173, publicBase: "https://x" });
  assert.equal(svc.cleanup("a", "r1"), 1);
  assert.equal(svc.list("a").length, 1);
  assert.equal(svc.list("b").length, 1);
});
