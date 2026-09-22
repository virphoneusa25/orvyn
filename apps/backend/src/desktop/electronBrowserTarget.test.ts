import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getElectronBrowserTarget,
  resetElectronBrowserTargetsForTests,
  setElectronBrowserTarget,
} from "./electronBrowserTarget";

test("only loopback Electron targets are stored", () => {
  resetElectronBrowserTargetsForTests();
  const ok = setElectronBrowserTarget("t1", "http://127.0.0.1:4581", "brk_token_ok");
  assert.equal(ok.url, "http://127.0.0.1:4581");
  assert.equal(getElectronBrowserTarget("t1")?.token, "brk_token_ok");
  assert.equal(getElectronBrowserTarget("other"), undefined);
  assert.throws(() => setElectronBrowserTarget("t1", "https://evil.example", "brk_token_ok"));
  assert.throws(() => setElectronBrowserTarget("t1", "http://10.0.0.8:4581", "brk_token_ok"));
});
