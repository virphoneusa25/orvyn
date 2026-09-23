import { test } from "node:test";
import assert from "node:assert/strict";
import { officialRegistryRequestUrl, isOfficialRegistryUrl, fetchOfficialRegistry } from "./officialRegistryFetch.ts";

test("official registry URLs stay on registry.modelcontextprotocol.io /v0.1/servers", () => {
  const url = officialRegistryRequestUrl("github", 8);
  assert.equal(isOfficialRegistryUrl(url), true);
  assert.match(url, /search=github/);
  assert.match(url, /limit=8/);
  assert.equal(isOfficialRegistryUrl("https://evil.example/v0.1/servers"), false);
  assert.equal(isOfficialRegistryUrl("https://registry.modelcontextprotocol.io/v0/other"), false);
});

test("fetchOfficialRegistry maps HTML and JSON the same way as the renderer guard", async () => {
  const html = await fetchOfficialRegistry("x", 2, async () =>
    new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } })
  );
  assert.equal(html.ok, false);
  assert.match(html.error ?? "", /HTML/);

  const json = await fetchOfficialRegistry("", 2, async () =>
    new Response(JSON.stringify({ servers: [{ server: { name: "io.github.github/github-mcp-server" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(json.ok, true);
  assert.equal((json.body as { servers: { server: { name: string } }[] }).servers[0].server.name, "io.github.github/github-mcp-server");
});
