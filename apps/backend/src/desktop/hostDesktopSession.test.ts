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
  setHostDesktopAllowed(false);
  const denied = beginHostAgentAction("click");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /Host desktop control is off/);
});

test("Take Control pauses ORION; Return to ORION resumes", () => {
  setHostDesktopAllowed(true);
  returnHostControl();
  const ok = beginHostAgentAction("screenshot");
  assert.equal(ok.ok, true);
  const taken = takeHostControl();
  assert.equal(taken.controlOwner, "user");
  const paused = beginHostAgentAction("click");
  assert.equal(paused.ok, false);
  if (!paused.ok) assert.match(paused.error, /User took control/);
  returnHostControl();
  assert.equal(getHostDesktopState().controlOwner, "orion");
  setHostDesktopAllowed(false);
});
