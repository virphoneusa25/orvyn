import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHED_FRAME_PATH, frameCaptureCommand, formatDesktopCommand, jpegFromOutput, pngFromOutput, usesCachedFrame } from "./sandboxDesktop";

test("frame capture grabs the root window instead of waiting for a click", () => {
  const cmd = frameCaptureCommand("auto");
  assert.match(cmd, /xwd -root -silent/);
  assert.doesNotMatch(cmd, /\bimport\b/);
  assert.match(frameCaptureCommand("low"), /-resize 55%/);
  assert.match(frameCaptureCommand("high"), /-quality 92/);
  assert.equal(usesCachedFrame("auto"), true);
  assert.equal(usesCachedFrame("low"), true);
  assert.equal(usesCachedFrame("high"), false);
  assert.equal(CACHED_FRAME_PATH, "/tmp/orvyn-frame.jpg");
});

test("desktop commands stay on one line the input reader can trust", () => {
  assert.equal(formatDesktopCommand("move", 10.2, 20.8), "MOVE 10 21");
  assert.equal(formatDesktopCommand("click", 3, 4), "CLICK 3 4 1");
  assert.equal(formatDesktopCommand("key", 0, 0, { key: "Enter" }), "KEY Return");
  assert.equal(formatDesktopCommand("key", 0, 0, { key: "rm -rf" }), null);
  assert.match(formatDesktopCommand("type", 0, 0, { text: "hi" }) ?? "", /^TYPE [A-Za-z0-9+/=]+$/);
});

test("JPEG bytes are recovered when a warning is prefixed", () => {
  const jpeg = Buffer.concat([Buffer.from("warning\n"), Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(120, 1)]);
  const out = jpegFromOutput(jpeg);
  assert.ok(out);
  assert.equal(out![0], 0xff);
  assert.equal(out![1], 0xd8);
  assert.equal(jpegFromOutput(Buffer.from("not an image")), null);
});

test("PNG magic is found in capture output", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(120, 2)]);
  assert.equal(pngFromOutput(png)?.[0], 0x89);
  assert.equal(pngFromOutput(Buffer.alloc(10)), null);
});
