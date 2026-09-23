import { test } from "node:test";
import assert from "node:assert/strict";
import { imageKind, sessionCanStream, shouldCoverFrame } from "./desktopStream.ts";

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

test("JPEG and PNG bytes count as a frame without a Content-Type", () => {
  assert.equal(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(imageKind(new Uint8Array([0x7b, 0x22, 0x65])), null);
});
