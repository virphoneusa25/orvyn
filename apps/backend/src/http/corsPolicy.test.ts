import { test } from "node:test";
import assert from "node:assert/strict";
import { originAllowed } from "./corsPolicy";

const pub = "https://orvyn.virphoneusa.com";

test("cloud mode allows Electron file and null origins", () => {
  assert.equal(originAllowed(undefined, true, pub), true);
  assert.equal(originAllowed("null", true, pub), true);
  assert.equal(originAllowed("file://", true, pub), true);
});

test("cloud mode allows the public host and localhost dev", () => {
  assert.equal(originAllowed("https://orvyn.virphoneusa.com", true, pub), true);
  assert.equal(originAllowed("http://localhost:43123", true, pub), true);
});

test("cloud mode denies an arbitrary browser origin", () => {
  assert.equal(originAllowed("https://evil.example", true, pub), false);
  assert.equal(originAllowed("not a url", true, pub), false);
});

test("local mode allows any origin", () => {
  assert.equal(originAllowed("https://evil.example", false, pub), true);
});
