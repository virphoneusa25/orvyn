import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("public legal HTTP response and registration enforce the same current version", async () => {
  // The real router uses only disposable local storage, never a customer database.
  process.env.ORVYN_DATA_DIR = mkdtempSync(join(tmpdir(), "orvyn-signup-legal-test-"));
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) delete process.env[key];
  const express = require("express");
  const { authRouter } = require("./auth");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`;
  try {
    const bundleResponse = await fetch(`${base}/legal`);
    assert.equal(bundleResponse.status, 200);
    const bundle = await bundleResponse.json() as any;
    assert.equal(bundle.accepted, false);
    assert.equal(bundle.acceptance, null);
    assert.ok(bundle.version);
    assert.equal(bundle.requiredDocuments.length, 4);
    for (const id of bundle.requiredDocuments) {
      assert.ok(bundle.documents.some((doc: any) => doc.id === id && doc.requiredForAcceptance && doc.content && doc.title));
    }
    const register = (legal: object) => fetch(`${base}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "promotion-test@example.invalid", password: "LocalTestOnly42!", name: "Promotion Test", client: "web", ...legal }),
    });
    for (const legal of [{ acceptTerms: true }, { legalAccepted: false, legalVersion: bundle.version },
      { legalAccepted: true, legalVersion: "stale-version" }]) {
      const response = await register(legal);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as any).code, "LEGAL_ACCEPTANCE_REQUIRED");
    }
    const response = await register({ legalAccepted: true, legalVersion: bundle.version });
    assert.equal(response.status, 201);
    const account = await response.json() as any;
    assert.ok(account.token);
    const accepted = await fetch(`${base}/legal`, { headers: { authorization: `Bearer ${account.token}` } });
    const signedInBundle = await accepted.json() as any;
    assert.equal(signedInBundle.accepted, true);
    assert.equal(signedInBundle.acceptance.version, bundle.version);
    assert.equal(signedInBundle.acceptance.source, "web-signup");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
});
