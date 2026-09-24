import { test } from "node:test";
import assert from "node:assert/strict";
import { base64ToBytes, desktopMayAutoStart, gatePointerMove, imageKind, parseSseBlock, releasePointerMove, sessionCanStream, shouldCoverFrame } from "./desktopStream.ts";

test("ending a session does not auto-start another one", () => {
  const open = {
    userStopped: false,
    alreadyStarted: false,
    hasProject: true,
    sandboxAvailable: true,
    hasSession: false,
    starting: false,
  };
  assert.equal(desktopMayAutoStart(open), true);
  assert.equal(desktopMayAutoStart({ ...open, userStopped: true }), false);
  assert.equal(desktopMayAutoStart({ ...open, hasSession: true }), false);
  assert.equal(desktopMayAutoStart({ ...open, starting: true }), false);
});

test("a Desktop tab that is not on screen never starts a desktop", () => {
  const open = { userStopped: false, alreadyStarted: false, hasProject: true, sandboxAvailable: true, hasSession: false, starting: false };
  assert.equal(desktopMayAutoStart({ ...open, visible: false }), false);
  assert.equal(desktopMayAutoStart({ ...open, visible: true }), true);
});

test("stream events parse into a frame", () => {
  const ev = parseSseBlock("event: frame\ndata: /9j/AA==");
  assert.equal(ev.event, "frame");
  const bytes = base64ToBytes(ev.data);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(parseSseBlock(": heartbeat").event, "message");
});

test("a ready ORION session streams even if live was omitted", () => {
  assert.equal(sessionCanStream({ status: "ready", controlOwner: "orion" } as { status: string }), true);
  assert.equal(sessionCanStream({ status: "ready", live: true }), true);
  assert.equal(sessionCanStream({ status: "starting", live: false }), false);
  assert.equal(sessionCanStream(null), false);
});

test("one slow frame does not cover a picture that just arrived", () => {
  const now = 1_000_000;
  assert.equal(shouldCoverFrame(0, now), true);
  assert.equal(shouldCoverFrame(now - 2_000, now), false);
  assert.equal(shouldCoverFrame(now - 20_000, now), true);
});

test("pointer moves collapse to the newest position", () => {
  const first = gatePointerMove({ inFlight: false, pending: null }, { x: 1, y: 2 });
  assert.deepEqual(first.send, { x: 1, y: 2 });
  const queued = gatePointerMove(first.gate, { x: 9, y: 8 });
  assert.equal(queued.send, null);
  assert.deepEqual(queued.gate.pending, { x: 9, y: 8 });
  const again = gatePointerMove(queued.gate, { x: 4, y: 5 });
  assert.deepEqual(again.gate.pending, { x: 4, y: 5 });
  const released = releasePointerMove(again.gate);
  assert.deepEqual(released.send, { x: 4, y: 5 });
  assert.equal(releasePointerMove(released.gate).send, null);
  assert.equal(releasePointerMove(released.gate).gate.inFlight, false);
});

test("JPEG and PNG bytes count as a frame without a Content-Type", () => {
  assert.equal(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(imageKind(new Uint8Array([0x7b, 0x22, 0x65])), null);
});
