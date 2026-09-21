// Hybrid search contract: ranked results combining signals, symbol lookup,
// file finding, and related-file detection over a real fixture project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HybridSearch } from "./HybridSearch";

function fixture(): { root: string; files: Map<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "orvyn-hs-"));
  const files = new Map<string, string>([
    ["src/auth/login.ts", "export function loginUser(user, pass) {\n  validateSession(user);\n  return true;\n}\nexport function validateSession(u) { return !!u; }"],
    ["src/auth/session.ts", "export interface Session { token: string }\nexport function createSession(user) {\n  return { token: 'abc' };\n}"],
    ["src/calc/math.ts", "export function add(a, b) {\n  return a + b;\n}\nexport function subtract(a, b) {\n  return a - b;\n}"],
    ["src/utils/helpers.ts", "export function formatDate(d) { return d.toISOString(); }"],
    ["package.json", "{\"name\":\"test\"}"],
  ]);
  for (const [rel, content] of files) {
    const full = join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, files };
}
import * as path from "path";

test("searchCodebase: finds the right file for a code-level query", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const hits = await hs.searchCodebase("validateSession", 5);
    assert.ok(hits.length > 0, "should find hits");
    assert.ok(hits.some((h) => h.path.includes("auth")), `auth file in results: ${hits.map((h) => h.path).join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findSymbol: locates the function definition", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const hits = await hs.findSymbol("loginUser");
    assert.ok(hits.length > 0, "finds loginUser");
    assert.equal(hits[0].path, "src/auth/login.ts");
    assert.equal(hits[0].symbol, "function loginUser");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findFile: partial path match, shortest wins", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const found = await hs.findFile("math");
    assert.ok(found.includes("src/calc/math.ts"));
    assert.equal(found[0], "src/calc/math.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relatedFiles: same directory and shared symbols rank higher", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const related = await hs.relatedFiles("src/auth/login.ts");
    assert.ok(related.includes("src/auth/session.ts"), `session.ts related (same dir + shared symbol): ${related.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recently-edited files get a scoring boost", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [{ path: "src/utils/helpers.ts", startLine: 1, endLine: 1, snippet: "formatDate", score: 0.5 }],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    hs.noteFileChanged("src/utils/helpers.ts");
    const hits = await hs.searchCodebase("formatDate", 5);
    const boosted = hits.find((h) => h.path === "src/utils/helpers.ts");
    assert.ok(boosted, "recently-edited file in results");
    assert.ok(boosted!.matchedBy.includes("recent"), "has 'recent' signal");
    assert.ok(boosted!.score > 0.5, "score boosted above raw semantic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
