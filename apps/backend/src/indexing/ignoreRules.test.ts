import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretPath, shouldIgnoreRelative, matchIgnoreGlob, skipReason } from "./ignoreRules";

test("secret exclusions catch env files, keys, and credential names", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath("apps/backend/.env.local"), true);
  assert.equal(isSecretPath("certs/server.pem"), true);
  assert.equal(isSecretPath("id_rsa"), true);
  assert.equal(isSecretPath("src/auth/session.ts"), false);
});

test("ignore dirs and binaries", () => {
  assert.equal(shouldIgnoreRelative("node_modules/leftpad/index.js"), true);
  assert.equal(shouldIgnoreRelative("dist/bundle.js"), true);
  assert.equal(shouldIgnoreRelative("logo.png"), true);
  assert.equal(shouldIgnoreRelative("src/index.ts"), false);
});

test("gitignore-style globs", () => {
  assert.equal(matchIgnoreGlob("coverage/out.txt", "coverage/"), true);
  assert.equal(matchIgnoreGlob("src/foo.test.ts", "*.test.ts"), true);
  assert.equal(matchIgnoreGlob("src/foo.ts", "*.test.ts"), false);
});

test("skip reasons are recorded", () => {
  assert.equal(skipReason(".env", 12), "secret");
  assert.equal(skipReason("vendor/lib.js", 10), "ignored");
  assert.equal(skipReason("src/app.ts", 80), null);
  assert.equal(skipReason("public/app.min.js", 100), "minified");
});
