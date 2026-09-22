import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_BACKEND_URL,
  ORVYN_CLOUD_URL,
  connectionMode,
  describeTransport,
  getConnectionConfig,
  saveConnectionConfig,
  secureBackendUrl,
  toWebSocketUrl,
  authHeaders,
} from "./connection.ts";

test("cloud URL defaults to the OVH host and local stays localhost", () => {
  assert.equal(ORVYN_CLOUD_URL, "https://orvyn.virphoneusa.com");
  assert.equal(connectionMode(LOCAL_BACKEND_URL), "local");
  assert.equal(connectionMode(ORVYN_CLOUD_URL), "cloud");
});

test("https cloud URLs become wss and localhost stays ws", () => {
  assert.equal(
    toWebSocketUrl("https://orvyn.virphoneusa.com", "/ws/chat", "orvsess_abc"),
    "wss://orvyn.virphoneusa.com/ws/chat?token=orvsess_abc"
  );
  assert.equal(toWebSocketUrl("http://localhost:4570", "/ws/chat"), "ws://localhost:4570/ws/chat");
});

test("plaintext cloud URLs are upgraded to https before a credential is stored", () => {
  assert.equal(secureBackendUrl("http://orvyn.virphoneusa.com"), "https://orvyn.virphoneusa.com");
  assert.equal(secureBackendUrl("http://localhost:4570"), "http://localhost:4570");
  assert.throws(() => secureBackendUrl("ftp://orvyn.virphoneusa.com"), /https/);
});

test("cloud transport stays on the OVH host and never rewrites to localhost", () => {
  const cloud = describeTransport("http://orvyn.virphoneusa.com");
  assert.equal(cloud.mode, "cloud");
  assert.equal(cloud.backendHost, "orvyn.virphoneusa.com");
  assert.equal(cloud.wsHost, "orvyn.virphoneusa.com");
  assert.equal(cloud.wsScheme, "wss");
  assert.equal(JSON.stringify(cloud).includes("localhost"), false);
  const local = describeTransport("http://localhost:4570");
  assert.equal(local.mode, "local");
  assert.equal(local.wsScheme, "ws");
  assert.equal(local.backendHost, "localhost:4570");
});

test("Bearer header is the session token and is omitted when signed out", async () => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    orvyn: {
      config: {
        async set(config: { backendUrl: string; apiKey: string }) {
          return config;
        },
      },
    },
  };
  try {
    await saveConnectionConfig({ backendUrl: "http://orvyn.virphoneusa.com", apiKey: "orvsess_test" });
    assert.deepEqual(authHeaders(), { Authorization: "Bearer orvsess_test" });
    assert.equal(getConnectionConfig().backendUrl, "https://orvyn.virphoneusa.com");
    await saveConnectionConfig({ backendUrl: "http://localhost:4570", apiKey: "" });
    assert.deepEqual(authHeaders(), {});
    assert.equal(connectionMode(getConnectionConfig().backendUrl), "local");
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
});
