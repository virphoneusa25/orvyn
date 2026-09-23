import { test } from "node:test";
import assert from "node:assert/strict";
import { createDesktopSession, markDesktopReady, resetDesktopSessionsForTests } from "../desktop/desktopSession";
import { DesktopSessionService } from "./DesktopSessionService";
import { ComputerUseCapability } from "./ComputerUseCapability";
import type { ComputerUseIdentity } from "./types";
import { runWithComputerContext, trustedIdentity } from "./context";

function id(over: Partial<ComputerUseIdentity> = {}): ComputerUseIdentity {
  return {
    tenantId: "tenant-a",
    projectRoot: "/workspace/demo",
    userId: "user-1",
    runId: "run-1",
    ...over,
  };
}

test("same DesktopSession survives model fallback (same tenant + project)", () => {
  resetDesktopSessionsForTests();
  const svc = new DesktopSessionService();
  const first = svc.ensureSession(id({ runId: "run-1" }));
  markDesktopReady(first);
  const afterFallback = svc.ensureSession(id({ runId: "run-1-after-switch" }));
  assert.equal(afterFallback.id, first.id, "project-keyed session must not fork on model switch");
  assert.equal(afterFallback.tenantId, "tenant-a");
});

test("tenant B cannot see tenant A's session", () => {
  resetDesktopSessionsForTests();
  const svc = new DesktopSessionService();
  const a = svc.ensureSession(id());
  assert.equal(svc.getSession(id({ tenantId: "tenant-b" }))?.id, undefined);
  assert.notEqual(svc.ensureSession(id({ tenantId: "tenant-b" })).id, a.id);
});

test("Take Control pauses ORION input without marking Desktop broken", async () => {
  resetDesktopSessionsForTests();
  const svc = new DesktopSessionService();
  const session = svc.ensureSession(id());
  markDesktopReady(session);
  assert.equal(svc.handoffControl(id(), "user").ok, true);
  const sent = await svc.sendInput(id(), "click", { x: 10, y: 10 });
  assert.equal(sent.ok, false);
  assert.match(sent.error ?? "", /taken control|paused/i);
  const view = svc.publicView(id());
  assert.ok(view);
  assert.notEqual(view.status, "error");
});

test("Return to ORION restores agent control on the same session", async () => {
  resetDesktopSessionsForTests();
  const svc = new DesktopSessionService();
  const session = svc.ensureSession(id());
  markDesktopReady(session);
  svc.handoffControl(id(), "user");
  const back = svc.handoffControl(id(), "orion");
  assert.equal(back.ok, true);
  assert.equal(back.returned, true);
  const sent = await svc.sendInput(id(), "type", { text: "ok" });
  assert.equal(sent.ok, true);
  assert.equal(sent.sessionId, session.id);
});

test("provider-independent screenshot miss keeps desktopHealthy", async () => {
  resetDesktopSessionsForTests();
  const cap = new ComputerUseCapability(new DesktopSessionService());
  const result = await cap.act({ action: "screenshot", identity: id(), surface: "desktop" });
  assert.equal(result.desktopHealthy, true);
  assert.equal(result.ok, false);
});

test("browser-first routing when a browser session id is present", () => {
  const cap = new ComputerUseCapability(new DesktopSessionService());
  assert.equal(cap.resolveSurface({ action: "click", identity: id({ browserSessionId: "/p" }), surface: "auto" }), "browser");
  assert.equal(cap.resolveSurface({ action: "click", identity: id({ desktopSessionId: "desk_1" }), surface: "auto" }), "desktop");
  assert.equal(cap.resolveSurface({ action: "click", identity: id(), surface: "browser" }), "browser");
});

test("trusted identity ignores model-supplied tenant/user/run", async () => {
  const bound = await runWithComputerContext(
    { tenantId: "trusted-t", projectRoot: "/real", userId: "trusted-u", runId: "trusted-r" },
    () => trustedIdentity({ tenantId: "bound-t", projectRoot: "/bound" }, "desk_hint")
  );
  assert.equal(bound.tenantId, "trusted-t");
  assert.equal(bound.userId, "trusted-u");
  assert.equal(bound.runId, "trusted-r");
  assert.equal(bound.desktopSessionId, "desk_hint");
});

test("host computer-use stays tenant-scoped and does not mark Desktop broken when opt-in is off", async () => {
  const cap = new ComputerUseCapability(new DesktopSessionService());
  const result = await cap.act({
    action: "click",
    identity: id(),
    surface: "host",
    x: 1,
    y: 1,
  });
  assert.equal(result.desktopHealthy, true);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Host desktop|not Windows/i);
});

test("creating a session does not invent a hidden second desktop for another run on the same project", () => {
  resetDesktopSessionsForTests();
  const svc = new DesktopSessionService();
  const visible = createDesktopSession({ tenantId: "tenant-a", projectRoot: "/workspace/demo", runId: "chat-1" });
  markDesktopReady(visible);
  const viaService = svc.ensureSession(id({ runId: "chat-1-fallback" }));
  assert.equal(viaService.id, visible.id);
});
