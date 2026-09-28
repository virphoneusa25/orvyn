import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startRoute, weightFor } from "./routingPolicy";
import { ModelService } from "../services/ModelService";

test("with only Nebius registered, each tier uses the matching Nebius model family", () => {
  const ids = [
    "nebius:moonshotai/Kimi-K2-Instruct",
    "nebius:zai-org/GLM-4.5",
    "nebius:deepseek-ai/DeepSeek-V3-0324",
    "nebius:deepseek-ai/DeepSeek-R1-0528",
    "nebius:Qwen/Qwen3-235B-A22B-Instruct-2507",
  ];
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: ids }).registryId, "nebius:moonshotai/Kimi-K2-Instruct");
  assert.equal(startRoute({ profile: "auto", instruction: "Create hello.txt", availableIds: ids }).registryId, "nebius:deepseek-ai/DeepSeek-V3-0324");
  assert.equal(startRoute({ profile: "server", instruction: "nginx 502", availableIds: ids }).registryId, "nebius:Qwen/Qwen3-235B-A22B-Instruct-2507");
  assert.equal(weightFor("nebius:zai-org/GLM-4.5"), 6);
  // Named candidates still win when their provider is configured.
  assert.equal(startRoute({ profile: "code", instruction: "Refactor utils", availableIds: [...ids, "fw:accounts/fireworks/models/kimi-k2p7-code"] }).registryId, "fw:accounts/fireworks/models/kimi-k2p7-code");
});

test("NEBIUS_API_KEY registers the account's live chat catalog", async () => {
  let auth = "";
  const server = createServer((req, res) => {
    auth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "moonshotai/Kimi-K2-Instruct" }, { id: "BAAI/bge-en-icl" }, { id: "black-forest-labs/flux-dev" }, { id: "zai-org/GLM-4.5" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const saved = { key: process.env.NEBIUS_API_KEY, url: process.env.NEBIUS_BASE_URL };
  delete process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const service = new ModelService();
    const added = await service.refreshNebiusCatalog("test-key");
    const ids = service.registry.list().map((p) => p.config.id).filter((id) => id.startsWith("nebius:"));
    assert.equal(auth, "Bearer test-key");
    assert.equal(added, 2);
    assert.deepEqual(ids.sort(), ["nebius:moonshotai/Kimi-K2-Instruct", "nebius:zai-org/GLM-4.5"]);
  } finally {
    process.env.NEBIUS_API_KEY = saved.key; process.env.NEBIUS_BASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.NEBIUS_API_KEY;
    if (saved.url === undefined) delete process.env.NEBIUS_BASE_URL;
    server.close();
  }
});
