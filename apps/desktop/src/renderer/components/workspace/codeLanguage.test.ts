import { test } from "node:test";
import assert from "node:assert/strict";
import { guessLanguage } from "./codeLanguage.ts";

test("code previews pick the right Monaco language per file", () => {
  assert.equal(guessLanguage("styles.css"), "css");
  assert.equal(guessLanguage("theme.scss"), "scss");
  assert.equal(guessLanguage("old.sass"), "sass");
  assert.equal(guessLanguage("vars.less"), "less");
  assert.equal(guessLanguage("index.html"), "html");
  assert.equal(guessLanguage("page.htm"), "html");
  assert.equal(guessLanguage("index.js"), "javascript");
  assert.equal(guessLanguage("app.ts"), "typescript");
  assert.equal(guessLanguage("component.tsx"), "typescript");
  assert.equal(guessLanguage("widget.jsx"), "javascript");
  assert.equal(guessLanguage("package.json"), "json");
  assert.equal(guessLanguage("README.md"), "markdown");
  assert.equal(guessLanguage("Dockerfile"), "dockerfile");
  assert.equal(guessLanguage("main.py"), "python");
  assert.equal(guessLanguage("server.go"), "go");
  assert.equal(guessLanguage("lib.rs"), "rust");
  assert.equal(guessLanguage("Main.java"), "java");
  assert.equal(guessLanguage("app.php"), "php");
  assert.equal(guessLanguage("run.rb"), "ruby");
  assert.equal(guessLanguage("deploy.sh"), "shell");
  assert.equal(guessLanguage("query.sql"), "sql");
  assert.equal(guessLanguage("config.yaml"), "yaml");
  assert.equal(guessLanguage("data.xml"), "xml");
  assert.equal(guessLanguage("logo.svg"), "xml");
});

test("unknown formats fall back to plain text (still readable, never wrong colors)", () => {
  assert.equal(guessLanguage("mystery.xyz"), "plaintext");
  assert.equal(guessLanguage("no-extension"), "plaintext");
});
