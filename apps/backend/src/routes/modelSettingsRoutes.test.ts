import test from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import { ModelRegistry, ModelRouter } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { installModelSettingsRoutes, type ModelSettingsTenant } from "./modelSettingsRoutes";

const config = (name = "original") => ({ id: "fixture", name, provider: "mock", capabilities: { chat: true, code: true, completion: true, agent: true } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(): ModelSettingsTenant {
  // Use the real preparation/publication methods without booting live providers.
  const service = Object.create(ModelService.prototype);
  service.registry = new ModelRegistry(); service.router = new ModelRouter(service.registry);
  service.userModelIds = new Set(); service.usage = { wrap: (provider: unknown) => provider }; service.preferredModel = null;
  return { id: "fixture", modelService: service, localStore: { saveModel: async () => {}, deleteModel: async () => {}, setSetting: async () => {} } };
}
async function withApi(tenant: ModelSettingsTenant, run: (call: (path: string, method: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const previous = process.env.ORVYN_CUSTOMER_CATALOG; process.env.ORVYN_CUSTOMER_CATALOG = "false";
  const app = express(); app.use(express.json()); const router = Router(); installModelSettingsRoutes(router, () => tenant); app.use(router);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).json({ error: "storage unavailable" }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run((path, method, body) => fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); if (previous === undefined) delete process.env.ORVYN_CUSTOMER_CATALOG; else process.env.ORVYN_CUSTOMER_CATALOG = previous; }
}

test("model publication waits for acknowledgement and failed replacement retains the original provider", async () => {
  const tenant = fixture(), entered = deferred(), gate = deferred();
  tenant.localStore.saveModel = async () => { entered.resolve(); await gate.promise; };
  await withApi(tenant, async (call) => {
    const create = call("/models", "POST", config());
    await entered.promise; assert.equal(tenant.modelService.registry.get("fixture"), undefined);
    gate.resolve(); assert.equal((await create).status, 201);
    const original = tenant.modelService.registry.get("fixture");
    tenant.localStore.saveModel = async () => { throw new Error("database offline"); };
    assert.equal((await call("/models/fixture", "PUT", config("replacement"))).status, 400);
    assert.equal(tenant.modelService.registry.get("fixture"), original);
    assert.equal((await call("/models", "POST", { ...config(), id: "invalid", provider: "invalid" })).status, 400);
    assert.equal(tenant.modelService.registry.get("invalid"), undefined);
  });
});

test("preferred model and routing remain unchanged after storage failures", async () => {
  const tenant = fixture(); tenant.modelService.addModel(config() as any, "user");
  tenant.modelService.router.setDefaultOverride("chat", "platform-default");
  tenant.localStore.setSetting = async () => { throw new Error("database offline"); };
  await withApi(tenant, async (call) => {
    assert.equal((await call("/models/preferred", "PUT", { modelId: "fixture" })).status, 503);
    assert.equal(tenant.modelService.preferredModel, null);
    assert.equal((await call("/routing", "POST", { task: "chat", modelId: "fixture" })).status, 503);
    assert.equal(tenant.modelService.router.getOverrides().chat, "platform-default");
    assert.equal((await call("/routing/chat", "DELETE")).status, 503);
    assert.equal(tenant.modelService.router.getOverrides().chat, "platform-default");
  });
});

test("concurrent routing edits preserve every acknowledged explicit override", async () => {
  const tenant = fixture(); tenant.modelService.addModel(config() as any, "user");
  tenant.modelService.router.setDefaultOverride("image", "installation-default");
  let saved: Record<string, string> = {};
  tenant.localStore.setSetting = async (_key, value) => { await new Promise((resolve) => setImmediate(resolve)); saved = JSON.parse(value); };
  await withApi(tenant, async (call) => {
    const responses = await Promise.all(["chat", "code", "completion", "agent"].map((task) => call("/routing", "POST", { task, modelId: "fixture" })));
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(saved, { chat: "fixture", code: "fixture", completion: "fixture", agent: "fixture" });
    assert.equal(tenant.modelService.router.getOverrides().image, "installation-default");
    assert.equal((await call("/routing/chat", "DELETE")).status, 200); assert.equal(saved.chat, undefined);
  });
});

test("failed model deletion retains its provider and queue accepts a later retry", async () => {
  const tenant = fixture(); tenant.modelService.addModel(config() as any, "user"); tenant.modelService.preferredModel = "fixture";
  let preferredCleared = false;
  tenant.localStore.setSetting = async () => { preferredCleared = true; };
  tenant.localStore.deleteModel = async () => { throw new Error("database offline"); };
  await withApi(tenant, async (call) => {
    assert.equal((await call("/models/fixture", "DELETE")).status, 503);
    assert.ok(tenant.modelService.registry.get("fixture")); assert.equal(preferredCleared, true); assert.equal(tenant.modelService.preferredModel, null);
    tenant.localStore.deleteModel = async () => {};
    assert.equal((await call("/models/fixture", "DELETE")).status, 204); assert.equal(tenant.modelService.registry.get("fixture"), undefined);
  });
});
