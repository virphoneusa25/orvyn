import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionFileRecord } from "./connectionRecord.ts";

test("session tokens are stored as ciphertext and never as apiKey", () => {
  const token = "orvsess_do-not-persist-this";
  const record = connectionFileRecord(
    { backendUrl: "https://orvyn.virphoneusa.com", apiKey: token },
    () => "ciphertext-only"
  );
  assert.equal(record.sessionTokenEnc, "ciphertext-only");
  assert.equal(record.apiKey, undefined);
  assert.equal(JSON.stringify(record).includes(token), false);
  assert.equal(JSON.stringify(record).includes("orvsess_"), false);
});

test("a session token is omitted entirely when the OS keychain is unavailable", () => {
  const token = "orvsess_do-not-persist-this";
  const record = connectionFileRecord(
    { backendUrl: "https://orvyn.virphoneusa.com", apiKey: token },
    () => null
  );
  assert.deepEqual(record, { backendUrl: "https://orvyn.virphoneusa.com" });
});

test("developer API keys remain in the config file and are not session tokens", () => {
  const record = connectionFileRecord(
    { backendUrl: "http://localhost:4570", apiKey: "dev-key" },
    () => {
      throw new Error("session encryption must not run for a developer key");
    }
  );
  assert.equal(record.apiKey, "dev-key");
  assert.equal(record.sessionTokenEnc, undefined);
});
