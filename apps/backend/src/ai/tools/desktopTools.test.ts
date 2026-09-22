import { test } from "node:test";
import assert from "node:assert/strict";
import { beginAgentAction, createDesktopSession, markDesktopReady, requestControl, resetDesktopSessionsForTests } from "../../desktop/desktopSession";

test("agent desktop actions queue while the user owns the session", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "t", projectRoot: "/p", runId: "r" });
  markDesktopReady(s);
  requestControl(s, "user");
  const r = beginAgentAction(s);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.queued, true);
    assert.match(r.reason, /User controls/i);
  }
});

test("user cannot act while ORION owns the session", () => {
  resetDesktopSessionsForTests();
  const s = createDesktopSession({ tenantId: "t", projectRoot: "/p" });
  markDesktopReady(s);
  assert.equal(s.controlOwner, "orion");
  requestControl(s, "orion");
  assert.equal(s.controlOwner, "orion");
  assert.equal(s.status, "agent_control");
});
