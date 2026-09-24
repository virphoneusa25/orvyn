import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRenderedPage, cloudBrowserUrl } from "./browserVerification";

const page = "<html><body><header><nav>Product</nav></header><main><h1>Wholesale voice for carriers</h1><p>Routes, rates, and coverage for teams that move real traffic.</p></main></body></html>";

test("a cloud localhost address is not opened in the desktop browser", () => {
  assert.equal(cloudBrowserUrl("cloud_worker", "http://127.0.0.1:5173/", ""), null);
  assert.equal(
    cloudBrowserUrl("cloud_worker", "http://127.0.0.1:5173/", "https://orvyn.example/api/v1/ports/p/proxy/?t=1"),
    "https://orvyn.example/api/v1/ports/p/proxy/?t=1"
  );
});

test("an empty 200 is not a verified page", () => {
  const empty = assessRenderedPage("https://preview.example/s", 200, "<html><body>ok</body></html>");
  assert.equal(empty.passed, false);
  const ready = assessRenderedPage("https://preview.example/s", 200, page);
  assert.equal(ready.passed, true);
  assert.equal(ready.expectedContentFound, true);
});
