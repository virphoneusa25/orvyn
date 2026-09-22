import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkFile, chunkContent } from "./chunker";

test("structural chunking keeps function ranges for TypeScript", () => {
  const src = [
    "export function alpha() {",
    "  return 1;",
    "}",
    "export function beta() {",
    "  return 2;",
    "}",
  ].join("\n");
  const chunks = chunkFile("src/lib.ts", src);
  assert.ok(chunks.length >= 2, `expected symbol chunks, got ${chunks.length}`);
  assert.ok(chunks.some((c) => c.symbol === "alpha"));
  assert.ok(chunks.some((c) => c.symbol === "beta"));
  assert.ok(chunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine));
});

test("fallback chunking preserves line ranges for markdown", () => {
  const md = Array.from({ length: 200 }, (_, i) => `# heading ${i}`).join("\n");
  const chunks = chunkFile("README.md", md);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[0].endLine >= chunks[0].startLine);
});

test("legacy chunkContent still windows large files", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkContent(text, 60, 10);
  assert.ok(chunks.length > 1);
});
