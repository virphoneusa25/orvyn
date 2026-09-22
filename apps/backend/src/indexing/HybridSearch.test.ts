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

test("exact filename outranks a weaker semantic-looking path", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [
        { path: "src/utils/helpers.ts", startLine: 1, endLine: 2, snippet: "format", score: 0.9 },
      ],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const hits = await hs.searchCodebase("package.json", 5);
    assert.ok(hits[0].path.endsWith("package.json"), `expected package.json first, got ${hits[0]?.path}`);
    assert.ok(hits[0].matchedBy.includes("filename") || hits[0].matchedBy.includes("exact-file"));
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

test("diversity caps chunks per file so one file cannot collapse results", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => [
        { path: "src/auth/login.ts", startLine: 1, endLine: 2, snippet: "a", score: 0.99 },
        { path: "src/auth/login.ts", startLine: 3, endLine: 4, snippet: "b", score: 0.98 },
        { path: "src/auth/login.ts", startLine: 5, endLine: 6, snippet: "c", score: 0.97 },
        { path: "src/auth/login.ts", startLine: 7, endLine: 8, snippet: "d", score: 0.96 },
        { path: "src/auth/session.ts", startLine: 1, endLine: 2, snippet: "e", score: 0.4 },
      ],
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const hits = await hs.searchCodebase("session token helper", 8);
    const loginHits = hits.filter((h) => h.path === "src/auth/login.ts").length;
    assert.ok(loginHits <= 3, `expected at most 3 chunks from login.ts, got ${loginHits}`);
    assert.ok(hits.some((h) => h.path !== "src/auth/login.ts"), "other files still appear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic outage still returns keyword/symbol hits", async () => {
  const { root, files } = fixture();
  try {
    const hs = new HybridSearch({
      projectRoot: root,
      semanticSearch: async () => { throw new Error("Qdrant down"); },
      listFiles: async () => [...files.keys()],
      readFile: async (rel) => files.get(rel) ?? "",
    });
    const hits = await hs.searchCodebase("loginUser", 5);
    assert.ok(hits.length > 0, "fallback search must still work");
    assert.ok(hits.some((h) => h.matchedBy.includes("symbol") || h.matchedBy.includes("keyword")));
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
