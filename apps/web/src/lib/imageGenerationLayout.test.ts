import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("image result CSS uses natural height and responsive width without placeholder height", () => {
  const css = readFileSync(new URL("../components/ImageGenerationMessage.css", import.meta.url), "utf8");
  assert.match(css, /\.image-generation__image\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/);
  assert.match(css, /max-width:\s*100%/);
  assert.doesNotMatch(css, /image-generation__image[^}]*height:\s*\d+px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /image-generation__actions\s*\{[^}]*flex-wrap:\s*wrap/);
});
