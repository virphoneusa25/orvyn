import { test } from "node:test";
import assert from "node:assert/strict";
import { clientToRemote, letterboxRect, remoteToClient } from "./desktopMapping.ts";

test("letterboxRect centers and preserves aspect", () => {
  // 1280x720 remote in a 1000x800 container → width-limited, vertical bands.
  const r = letterboxRect(1000, 800, 1280, 720);
  assert.equal(r.w, 1000);
  assert.equal(Math.round(r.h), 563);
  assert.equal(r.x, 0);
  assert.ok(r.y > 100 && r.y < 120);

  // Narrow tall container → still width-limited, bands top/bottom.
  const r2 = letterboxRect(400, 800, 1280, 720);
  assert.equal(r2.w, 400);
  assert.equal(Math.round(r2.h), 225);
  assert.equal(r2.x, 0);
  assert.ok(r2.y > 200);

  // Wide short container → height-limited, bands left/right.
  const r3 = letterboxRect(2000, 400, 1280, 720);
  assert.equal(r3.h, 400);
  assert.ok(r3.w < 720);
  assert.equal(r3.y, 0);
  assert.ok(r3.x > 0);

  // Degenerate inputs never produce NaN/negative.
  assert.deepEqual(letterboxRect(0, 0, 1280, 720), { x: 0, y: 0, w: 0, h: 0 });
});

test("clientToRemote maps image-relative points to remote pixels", () => {
  const image = letterboxRect(1000, 800, 1280, 720);
  // Center of the image → center of the remote.
  const c = clientToRemote(image.x + image.w / 2, image.y + image.h / 2, image, 1280, 720);
  assert.deepEqual(c, { x: 640, y: 360 });
  // Top-left of image → remote origin.
  assert.deepEqual(clientToRemote(image.x, image.y, image, 1280, 720), { x: 0, y: 0 });
});

test("clientToRemote returns null in the letterbox band", () => {
  const image = letterboxRect(1000, 800, 1280, 720);
  // Above the image (inside the container, outside the framebuffer).
  assert.equal(clientToRemote(500, image.y - 10, image, 1280, 720), null);
  assert.equal(clientToRemote(-5, 500, image, 1280, 720), null);
});

test("remoteToClient inverts clientToRemote (ORION cursor overlay)", () => {
  const image = letterboxRect(1000, 800, 1280, 720);
  const p = remoteToClient(640, 360, image, 1280, 720);
  assert.ok(Math.abs(p.x - (image.x + image.w / 2)) < 1);
  assert.ok(Math.abs(p.y - (image.y + image.h / 2)) < 1);
  const back = clientToRemote(p.x, p.y, image, 1280, 720);
  assert.deepEqual(back, { x: 640, y: 360 });
});

test("mapping stays exact under Windows display scaling (CSS px in, CSS px out)", () => {
  // At 150% scaling the container reports ~2/3 the device pixels — but both
  // rect and point are CSS px, so the mapping is identical.
  const image = letterboxRect(666, 533, 1280, 720); // 1000x800 @ 150%
  const c = clientToRemote(image.x + image.w / 2, image.y + image.h / 2, image, 1280, 720);
  assert.deepEqual(c, { x: 640, y: 360 });
});
