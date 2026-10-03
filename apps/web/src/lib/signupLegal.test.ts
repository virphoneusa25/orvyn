import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseSignupLegalBundle, signupLegalAcceptance, LEGAL_LOAD_ERROR } from "./signupLegal.ts";

const require = createRequire(import.meta.url);
const { publicLegalBundle } = require("../../../backend/dist/legal/documents.js");

test("the actual backend legal bundle is reviewable and sends its exact current version", () => {
  const bundle = parseSignupLegalBundle(JSON.parse(JSON.stringify(publicLegalBundle())));
  assert.equal(bundle.requiredDocuments.length, 4);
  assert.deepEqual(signupLegalAcceptance(bundle, true), { legalAccepted: true, legalVersion: bundle.version });
  assert.throws(() => signupLegalAcceptance(bundle, false), /Agree to the current/);
});

test("missing, malformed, or incomplete legal responses block signup with a useful error", () => {
  const bundle = publicLegalBundle();
  for (const value of [null, {}, { ...bundle, version: "" }, { ...bundle, documents: [] },
    { ...bundle, requiredDocuments: [] }, { ...bundle, documents: bundle.documents.slice(1) }]) {
    assert.throws(() => parseSignupLegalBundle(value), { message: LEGAL_LOAD_ERROR });
  }
  assert.throws(() => signupLegalAcceptance(null, true), { message: LEGAL_LOAD_ERROR });
});
