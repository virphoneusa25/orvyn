import test from "node:test";
import assert from "node:assert/strict";
import type { AdminService } from "./AdminService";
import { createAsyncAdminService } from "./AsyncAdminService";

test("reporting shares one delayed backend and preserves receiver binding", async () => {
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = { label: "customer", orgByTenant(id: string) { return { name: this.label, id }; } };
  const reports = createAsyncAdminService(async () => { loads++; await gate; return backend as unknown as AdminService; });
  const first = reports.orgByTenant("a");
  const second = reports.orgByTenant("b");
  release();
  assert.equal((await first)?.name, "customer");
  assert.equal((await second)?.name, "customer");
  assert.equal(loads, 1);
});

test("reporting forwards asynchronous failures and never substitutes empty results", async () => {
  const failure = new Error("reporting unavailable");
  const reports = createAsyncAdminService(async () => { throw failure; });
  await assert.rejects(reports.counts(), err => err === failure);
  await assert.rejects(reports.search("customer"), err => err === failure);
});
