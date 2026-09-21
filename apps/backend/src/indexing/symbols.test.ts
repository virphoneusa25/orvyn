// Pins the structural parser contract: real symbols from real code shapes,
// deduplication, language detection, and the findSymbol ranking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols, findSymbols, languageOf } from "./symbols";

const TS_SAMPLE = `
import { readFile } from "fs";
import type { Foo } from "./foo";

export interface User {
  id: string;
  name: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function add(a: number, b: number): number {
  return a + b;
}

async function fetchData(url: string) {
  return fetch(url);
}

export class Calculator {
  private result = 0;

  add(a: number, b: number): number {
    this.result = a + b;
    return this.result;
  }

  clear(): void {
    this.result = 0;
  }
}

const multiply = (a: number, b: number) => a * b;
`;

test("languageOf: correct for common extensions", () => {
  assert.equal(languageOf("src/app.ts"), "typescript");
  assert.equal(languageOf("index.jsx"), "javascript");
  assert.equal(languageOf("main.py"), "python");
  assert.equal(languageOf("main.go"), "go");
  assert.equal(languageOf("lib.rs"), "rust");
  assert.equal(languageOf("README.md"), "plaintext");
});

test("extractSymbols: finds functions, classes, methods, interfaces, types, imports", () => {
  const symbols = extractSymbols(TS_SAMPLE, "calc.ts");
  const names = symbols.map((s) => `${s.kind}:${s.name}`);
  assert.ok(names.includes("interface:User"), `interface User — got: ${names.join(", ")}`);
  assert.ok(names.includes("type:Result"), `type Result`);
  assert.ok(names.includes("function:add"), `export function add`);
  assert.ok(names.includes("function:fetchData"), `async function fetchData`);
  assert.ok(names.includes("class:Calculator"), `export class Calculator`);
  assert.ok(names.some((n) => n === "method:add"), `class method add`);
  assert.ok(names.some((n) => n === "method:clear"), `class method clear`);
  assert.ok(names.includes("variable:multiply"), `const arrow function`);
  assert.ok(symbols.some((s) => s.kind === "import" && s.name === "fs"), `import fs`);
  assert.ok(symbols.some((s) => s.kind === "import" && s.name === "./foo"), `import type Foo`);
});

test("extractSymbols: deduplicates (same name+kind+line appears once)", () => {
  const symbols = extractSymbols(TS_SAMPLE, "calc.ts");
  const keys = symbols.map((s) => `${s.name}:${s.kind}:${s.startLine}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate symbol keys");
});

test("findSymbols: exact match wins, then prefix, then contains", () => {
  const symbols = extractSymbols(TS_SAMPLE, "calc.ts");
  const exact = findSymbols(symbols, "add");
  assert.ok(exact.every((s) => s.name === "add"), `exact 'add' — got: ${exact.map((s) => s.name).join(",")}`);
  const prefix = findSymbols(symbols, "fetch");
  assert.ok(prefix.length > 0 && prefix.every((s) => s.name.startsWith("fetch")));
});

const PY_SAMPLE = `
import os

class AuthManager:
    def login(self, user, password):
        return True

    def logout(self):
        pass

def helper():
    return 42

async def async_task():
    await asyncio.sleep(1)
`;

test("extractSymbols: Python classes and functions (including async)", () => {
  const symbols = extractSymbols(PY_SAMPLE, "auth.py");
  const names = symbols.map((s) => `${s.kind}:${s.name}`);
  assert.ok(names.includes("class:AuthManager"), `class AuthManager`);
  assert.ok(names.includes("function:login"), `def login`);
  assert.ok(names.includes("function:helper"), `def helper`);
  assert.ok(names.includes("function:async_task"), `async def async_task`);
});
