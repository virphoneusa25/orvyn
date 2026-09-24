import { test } from "node:test";
import assert from "node:assert/strict";
import { VAULT_DEV_KEY, isProductionVaultEnv, loadVaultKey, openSecret, sealSecret } from "./vault";

test("a secret sealed for one tenant does not open for another", () => {
  const sealed = sealSecret("customer-token", "tenant-a", "mcp.secret.github", VAULT_DEV_KEY);
  assert.equal(openSecret(sealed, "tenant-a", "mcp.secret.github", VAULT_DEV_KEY), "customer-token");
  assert.equal(openSecret(sealed, "tenant-b", "mcp.secret.github", VAULT_DEV_KEY), null);
  assert.equal(openSecret(sealed, "tenant-a", "mcp.secret.other", VAULT_DEV_KEY), null);
  assert.equal(sealed.includes("customer-token"), false);
});

test("production refuses a missing key and the development key", () => {
  assert.equal(isProductionVaultEnv({ ORVYN_CLOUD_MODE: "true" }), true);
  assert.throws(() => loadVaultKey({ ORVYN_ENV: "production" }), /ORVYN_VAULT_KEY is required/);
  assert.throws(
    () => loadVaultKey({ NODE_ENV: "production", ORVYN_VAULT_KEY: VAULT_DEV_KEY.toString("base64") }),
    /development vault key/,
  );
  const real = Buffer.alloc(32, 7).toString("base64");
  assert.equal(loadVaultKey({ ORVYN_ENV: "production", ORVYN_VAULT_KEY: real }).toString("base64"), real);
});

test("local development uses the development key when none is configured", () => {
  assert.equal(loadVaultKey({}).equals(VAULT_DEV_KEY), true);
});
