import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JpegSplitter,
  desktopIsIdle,
  DESKTOP_IDLE_MS,
  frameStreamCommand,
  orphanDesktopIds,
} from "./sandboxDesktop";
import { desktopAppName } from "../computerUse/DesktopSessionService";

function fakeJpeg(fill: number, size = 1200): Buffer {
  const body = Buffer.alloc(size, fill);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), body, Buffer.from([0xff, 0xd9])]);
}

test("MJPEG stream splits into whole pictures across chunk boundaries", () => {
  const a = fakeJpeg(1), b = fakeJpeg(2), c = fakeJpeg(3);
  const all = Buffer.concat([a, b, c]);
  const s = new JpegSplitter();
  const out = [
    ...s.push(all.subarray(0, 700)),
    ...s.push(all.subarray(700, 1300)),
    ...s.push(all.subarray(1300, 3000)),
    ...s.push(all.subarray(3000)),
  ];
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
  assert.deepEqual(out[2], c);
});

test("a marker split between two chunks is not lost", () => {
  const a = fakeJpeg(7);
  const s = new JpegSplitter();
  const first = s.push(a.subarray(0, a.length - 1));
  const second = s.push(a.subarray(a.length - 1));
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
});

test("frame stream command grabs the display with ffmpeg and exits 127 without it", () => {
  const cmd = frameStreamCommand(1280, 720, 8).join(" ");
  assert.match(cmd, /x11grab/);
  assert.match(cmd, /1280x720/);
  assert.match(cmd, /-framerate 8/);
  assert.match(cmd, /exit 127/);
});

test("only this backend's desktops (and unlabelled old ones) count as orphans", () => {
  const rows = ["aaa\tproduction", "bbb\tstaging", "ccc\t", "ddd\t<no value>"].join("\n");
  assert.deepEqual(orphanDesktopIds(rows, "production"), ["aaa", "ccc", "ddd"]);
  assert.deepEqual(orphanDesktopIds(rows, "staging"), ["bbb", "ccc", "ddd"]);
});

test("a desktop is idle only with no viewers, no user control and nothing recent", () => {
  const now = 10 * DESKTOP_IDLE_MS;
  const s = { id: "d", createdAt: 0, lastFrameAt: 0, controlOwner: "orion" as const };
  assert.equal(desktopIsIdle(s, now, 0, 0), true);
  assert.equal(desktopIsIdle(s, now, 1, 0), false);
  assert.equal(desktopIsIdle({ ...s, controlOwner: "user" }, now, 0, 0), false);
  assert.equal(desktopIsIdle(s, now, 0, now - 1000), false);
});

test("open_app understands the names people use", () => {
  assert.equal(desktopAppName("browser"), "chromium");
  assert.equal(desktopAppName("Firefox"), "chromium");
  assert.equal(desktopAppName("file manager"), "files");
  assert.equal(desktopAppName("VS Code"), "editor");
  assert.equal(desktopAppName("terminal"), "terminal");
  assert.equal(desktopAppName("spreadsheet"), null);
});
