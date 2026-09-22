import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDevServerUrls } from "./previewDetect";

test("detects Vite and Next local URLs", () => {
  const vite = detectDevServerUrls("  VITE v5 ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n");
  assert.equal(vite[0]?.url, "http://localhost:5173/");
  const next = detectDevServerUrls("▲ Next.js 14\n- Local:        http://127.0.0.1:3000");
  assert.equal(next.some((p) => p.url.includes("127.0.0.1:3000")), true);
});

test("ignores compile noise without a URL", () => {
  assert.deepEqual(detectDevServerUrls("compiling TypeScript…"), []);
});

test("keeps localhost ports for dynamic preview tabs", () => {
  const found = detectDevServerUrls("ORVYN preview http://127.0.0.1:43191");
  assert.equal(found[0]?.port, 43191);
  assert.match(found[0]!.label, /43191/);
});
