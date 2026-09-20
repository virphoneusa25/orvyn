// The icon contract: every supported extension resolves to a real entry
// with a language id and color; unknown extensions fall back to the generic
// glyph; no path shape crashes the parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_EXTENSIONS, extensionOf, fileTypeOf } from "./fileTypeRegistry.ts";

const SPEC_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "json", "html", "css", "scss", "md", "py", "go",
  "rs", "java", "cs", "cpp", "c", "h", "yml", "yaml", "xml", "sql", "sh",
  "ps1", "bat", "env", "toml", "vue", "svelte",
];

test("every spec-required extension has a registry entry", () => {
  for (const ext of SPEC_EXTENSIONS) {
    assert.ok(SUPPORTED_EXTENSIONS.includes(ext), `missing registry entry for .${ext}`);
  }
});

test("every entry has a language id and a color (renderable, no remote asset)", () => {
  for (const ext of SUPPORTED_EXTENSIONS) {
    const t = fileTypeOf(`x.${ext}`);
    assert.ok(t.languageId, `.${ext} needs a languageId`);
    assert.match(t.color, /^#[0-9a-f]{6}$/i, `.${ext} color must be a local hex`);
  }
});

test("extension parsing: names, paths, both separators, special names", () => {
  assert.equal(extensionOf("session.ts"), "ts");
  assert.equal(extensionOf("src/auth/session.tsx"), "tsx");
  assert.equal(extensionOf("C:\\x\\Dockerfile"), "dockerfile");
  assert.equal(extensionOf(".env.local"), "env");
  assert.equal(extensionOf("README.MD"), "md");
  assert.equal(extensionOf("noext"), "");
});

test("unknown extensions fall back to the generic type, never break", () => {
  const t = fileTypeOf("mystery.zzz999");
  assert.equal(t.languageId, "plaintext");
  assert.match(t.color, /^#/);
});
