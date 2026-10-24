import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tenantManager } from "../tenancy/TenantManager";
import { deploymentConnections, saveDeploymentConnection, removeDeploymentConnection, deploymentCredential } from "./deploymentConnections";
import { githubToken } from "./githubConnection";
import { sealSecret } from "../secrets/vault";
import { upsertSshHost, materializeIdentity } from "../ssh/sshHostStore";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function withStore(run: (store: { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }, rows: Map<string, string>) => Promise<void>) {
  const previousGet = tenantManager.get, previousKey = process.env.ORVYN_VAULT_KEY;
  process.env.ORVYN_VAULT_KEY = Buffer.alloc(32, 0x64).toString("base64");
  const rows = new Map<string, string>();
  const store = { getSetting: async (key: string) => rows.get(key) ?? null, setSetting: async (key: string, value: string) => { rows.set(key, value); } };
  tenantManager.get = ((id: string) => ({ id, localStore: store })) as any;
  try { await run(store, rows); }
  finally { tenantManager.get = previousGet; if (previousKey === undefined) delete process.env.ORVYN_VAULT_KEY; else process.env.ORVYN_VAULT_KEY = previousKey; }
}

test("deployment credentials await storage, remain sealed, and disconnect after acknowledgement", async () => {
  await withStore(async (store, rows) => {
    const entered = deferred(), gate = deferred(), save = store.setSetting;
    store.setSetting = async (key, value) => { entered.resolve(); await gate.promise; await save(key, value); };
    let finished = false;
    const request = saveDeploymentConnection("fixture", "vercel", "synthetic-provider-token").then(() => { finished = true; });
    await entered.promise; assert.equal(finished, false); assert.equal(rows.size, 0);
    gate.resolve(); await request;
    assert.notEqual(rows.get("integration.vercel.token"), "synthetic-provider-token");
    assert.equal((await deploymentConnections("fixture")).vercel.connected, true);
    assert.deepEqual(await deploymentCredential("fixture", "vercel"), { VERCEL_TOKEN: "synthetic-provider-token" });
    assert.equal(await deploymentCredential("foreign-tenant", "vercel"), null);
    store.setSetting = async () => { throw new Error("database offline"); };
    await assert.rejects(removeDeploymentConnection("fixture", "vercel"), /database offline/);
    assert.equal((await deploymentConnections("fixture")).vercel.connected, true);
    store.setSetting = save; await removeDeploymentConnection("fixture", "vercel");
    assert.equal(await deploymentCredential("fixture", "vercel"), null);
    assert.equal((await deploymentConnections("fixture")).vercel.connected, false);
    store.getSetting = async () => { throw new Error("database offline"); };
    await assert.rejects(deploymentConnections("fixture"), /database offline/);
  });
});

test("GitHub credential reads await storage and enforce tenant-bound encryption", async () => {
  await withStore(async (store, rows) => {
    rows.set("github.token", sealSecret("synthetic-github-token", "fixture", "github.token"));
    assert.equal(await githubToken("fixture"), "synthetic-github-token");
    assert.equal(await githubToken("foreign-tenant"), null);
    store.getSetting = async () => { throw new Error("database offline"); };
    await assert.rejects(githubToken("fixture"), /database offline/);
  });
});

test("SSH credentials await acknowledged storage and async reads before creating a temporary identity", async () => {
  await withStore(async (store, rows) => {
    const host = await upsertSshHost({ tenantId: "fixture", localStore: store, alias: "fixture", host: "fixture.invalid", user: "fixture", privateKey: "synthetic-private-key", scope: "session" });
    assert.ok(host.vaultKeyName); assert.notEqual(rows.get(host.vaultKeyName!), "synthetic-private-key");
    const identity = await materializeIdentity({ tenantId: "fixture", localStore: store, host });
    try { assert.equal(await readFile(identity.keyPath!, "utf8"), "synthetic-private-key\n"); }
    finally { await identity.cleanup(); }
    store.setSetting = async () => { throw new Error("database offline"); };
    await assert.rejects(upsertSshHost({ tenantId: "fixture", localStore: store, alias: "failed", host: "fixture.invalid", user: "fixture", privateKey: "synthetic-private-key", scope: "session" }), /database offline/);
  });
});
