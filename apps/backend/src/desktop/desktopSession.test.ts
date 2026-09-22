import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginAgentAction,
  canAgentAct,
  canUserAct,
  createDesktopSession,
  endAgentAction,
  endDesktopSession,
  findDesktopSession,
  getDesktopSession,
  mapClientPoint,
  markDesktopReady,
  requestControl,
  resetDesktopSessionsForTests,
  sessionKey,
  sweepIdleDesktopSessions,
  toPublic,
} from "./desktopSession";

test("one session per tenant+run and public shape hides internals", () => {
  resetDesktopSessionsForTests();
  const a = createDesktopSession({ tenantId: "t1", projectRoot: "/p", runId: "r1" });
  const b = createDesktopSession({ tenantId: "t1", projectRoot: "/p", runId: "r1" });
  assert.equal(a.id, b.id);
  markDesktopReady(a, "http://127.0.0.1:5173");
  const pub = toPublic(a);
  assert.equal(pub.live, true);
  assert.equal(pub.controlOwner, "orion");
  assert.equal(pub.url, "http://127.0.0.1:5173");
  assert.equal("inputInFlight" in pub, false);
});

test("Take Control and Return to ORION are exclusive", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "t1", projectRoot: "/p" });
  markDesktopReady(s);
  assert.equal(canAgentAct(s), true);
  assert.equal(canUserAct(s), false);

  const take = requestControl(s, "user");
  assert.equal(take.ok, true);
  assert.equal(s.controlOwner, "user");
  assert.equal(canAgentAct(s), false);
  assert.equal(canUserAct(s), true);

  const queued = beginAgentAction(s);
  assert.equal(queued.ok, false);
  if (!queued.ok) assert.equal(queued.queued, true);
  assert.equal(s.queuedAgentActions, 1);

  const back = requestControl(s, "orion");
  assert.equal(back.ok, true);
  assert.equal(canAgentAct(s), true);
  assert.equal(canUserAct(s), false);
});

test("control does not transfer mid-action", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "t1", projectRoot: "/p" });
  markDesktopReady(s);
  assert.equal(beginAgentAction(s).ok, true);
  const denied = requestControl(s, "user");
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? "", /in flight|finish/i);
  endAgentAction(s);
  assert.equal(requestControl(s, "user").ok, true);
});

test("tenant binding: another tenant cannot find the session", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "alpha", projectRoot: "/p", runId: "r" });
  assert.equal(findDesktopSession(s.id, "alpha")?.id, s.id);
  assert.equal(findDesktopSession(s.id, "beta"), undefined);
  assert.notEqual(sessionKey("alpha", "r"), sessionKey("beta", "r"));
});

test("coordinate mapping scales into the remote desktop", () => {
  const pt = mapClientPoint({ x: 100, y: 50, width: 640, height: 400 }, { width: 1280, height: 800 });
  assert.equal(pt.x, 200);
  assert.equal(pt.y, 100);
});

test("UI runId and tool projectRoot resolve to the same session", () => {
  resetDesktopSessionsForTests();
  const created = createDesktopSession({ tenantId: "t1", projectRoot: "/proj", runId: "run-a" });
  assert.equal(getDesktopSession("t1", "run-a", "/proj")?.id, created.id);
  assert.equal(getDesktopSession("t1", undefined, "/proj")?.id, created.id);
});

test("idle sweep ends unused sessions and skips in-flight agent work", () => {
  resetDesktopSessionsForTests();
  const idle = createDesktopSession({ tenantId: "t1", projectRoot: "/idle" });
  markDesktopReady(idle);
  idle.lastActionAt = Date.now() - 40 * 60 * 1000;
  const busy = createDesktopSession({ tenantId: "t1", projectRoot: "/busy" });
  markDesktopReady(busy);
  beginAgentAction(busy);
  const closed = sweepIdleDesktopSessions(Date.now());
  assert.equal(closed >= 1, true);
  assert.equal(idle.status, "ended");
  assert.equal(busy.status, "agent_control");
});

test("ended sessions reject both owners", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "t1", projectRoot: "/p" });
  markDesktopReady(s);
  endDesktopSession(s);
  assert.equal(canAgentAct(s), false);
  assert.equal(canUserAct(s), false);
  assert.equal(requestControl(s, "user").ok, false);
});
