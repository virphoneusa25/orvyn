import test from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import { installTenantDataRoutes, type TenantDataAccess } from "./tenantDataRoutes";
import { PROFILES } from "../gateway/PermissionProfiles";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const rows = new Map<string, any>();
  const tenant: TenantDataAccess = {
    currentProjectRoot: "/fixture", toolGateway: { profile: Object.keys(PROFILES)[0] as any },
    localStore: {
      listMemories: async () => [...rows.values()],
      saveMemory: async (row) => { rows.set(row.id, { ...row }); },
      getMemory: async (id) => rows.get(id) ?? null,
      deleteMemory: async (id) => { rows.delete(id); },
      listLearningRecords: async (kind) => [{ payload: { kind } }] as any,
      setSetting: async () => {},
    },
  };
  return tenant;
}
async function withApi(tenant: TenantDataAccess, run: (call: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const app = express(); app.use(express.json());
  const router = Router(); installTenantDataRoutes(router, () => tenant); app.use(router);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).json({ error: "storage unavailable" }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run((path, method = "GET", body) => fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("tenant data endpoints await async memory CRUD and learning-record reads", async () => {
  await withApi(fixture(), async (call) => {
    assert.equal((await call("/memory", "POST", { id: "fixture", scope: "global", content: "original" })).status, 201);
    assert.equal((await (await call("/memory")).json()).memories[0].content, "original");
    const updated = await call("/memory/fixture", "PATCH", { content: "updated" });
    assert.equal((await updated.json()).memory.content, "updated");
    assert.deepEqual(await (await call("/learning/skills")).json(), { skills: [{ kind: "skill" }] });
    assert.deepEqual(await (await call("/learning/datasets")).json(), { datasets: [{ kind: "dataset" }] });
    assert.equal((await call("/memory/fixture", "DELETE")).status, 204);
    assert.equal((await call("/memory/fixture", "PATCH", { content: "absent" })).status, 404);
  });
});

test("memory responses wait for storage acknowledgement and rejected writes reach error middleware", async () => {
  const tenant = fixture(), gate = deferred(), entered = deferred();
  tenant.localStore.saveMemory = async () => { entered.resolve(); await gate.promise; throw new Error("database offline"); };
  await withApi(tenant, async (call) => {
    let answered = false;
    const request = call("/memory", "POST", { scope: "global", content: "fixture" }).then((response) => { answered = true; return response; });
    await entered.promise; assert.equal(answered, false);
    gate.resolve(); assert.equal((await request).status, 503);
  });
});

test("profile changes publish only after acknowledgement and preserve the old profile on failure", async () => {
  const tenant = fixture(), original = tenant.toolGateway.profile;
  const target = Object.keys(PROFILES).find((key) => key !== original)!;
  const gate = deferred(), entered = deferred();
  tenant.localStore.setSetting = async () => { entered.resolve(); await gate.promise; throw new Error("database offline"); };
  await withApi(tenant, async (call) => {
    const request = call("/profile", "POST", { profile: target });
    await entered.promise; assert.equal(tenant.toolGateway.profile, original);
    gate.resolve(); assert.equal((await request).status, 503); assert.equal(tenant.toolGateway.profile, original);
    tenant.localStore.setSetting = async () => {};
    assert.equal((await call("/profile", "POST", { profile: target })).status, 200);
    assert.equal(tenant.toolGateway.profile, target);
  });
});
