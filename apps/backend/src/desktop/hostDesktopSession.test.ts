import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginHostAgentAction,
  getHostDesktopState,
  returnHostControl,
  setHostDesktopAllowed,
  takeHostControl,
} from "./hostDesktopSession";

test("host desktop is off by default and refuses agent input", () => {
  setHostDesktopAllowed("t1", false);
  const denied = beginHostAgentAction("t1", "click");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /Host desktop control is off/);
});

test("Take Control pauses ORION; Return to ORION resumes", () => {
  setHostDesktopAllowed("t1", true);
  returnHostControl("t1");
  const ok = beginHostAgentAction("t1", "screenshot");
  assert.equal(ok.ok, true);
  const taken = takeHostControl("t1");
  assert.equal(taken.controlOwner, "user");
  const paused = beginHostAgentAction("t1", "click");
  assert.equal(paused.ok, false);
  if (!paused.ok) assert.match(paused.error, /User took control/);
  returnHostControl("t1");
  assert.equal(getHostDesktopState("t1").controlOwner, "orion");
  setHostDesktopAllowed("t1", false);
});

test("tenant A cannot take or inspect tenant B host desktop", () => {
  setHostDesktopAllowed("tenant-a", true);
  returnHostControl("tenant-a");
  setHostDesktopAllowed("tenant-b", false);
  takeHostControl("tenant-a");
  assert.equal(getHostDesktopState("tenant-a").controlOwner, "user");
  assert.equal(getHostDesktopState("tenant-b").allowed, false);
  assert.equal(getHostDesktopState("tenant-b").controlOwner, "none");
  const steal = beginHostAgentAction("tenant-b", "click");
  assert.equal(steal.ok, false);
  setHostDesktopAllowed("tenant-a", false);
});
