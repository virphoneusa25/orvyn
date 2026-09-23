import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKETPLACE_DEBOUNCE_MS,
  degradedBanner,
  emptyKindFor,
  latestOnly,
  mergeCatalogPreferIncoming,
  providerDots,
  shouldKeepPreviousResults,
} from "./mcpCatalogClient.ts";
import type { MarketServer } from "./mcpMarketplaceModel.ts";

function server(name: string): MarketServer {
  return {
    canonicalId: name,
    name,
    description: name,
    sources: ["official"],
    categories: [],
    transports: [{ kind: "stdio" }],
    auth: [],
    trust: { level: "community", reasons: [] },
    compatibility: "compatible",
    networkRequired: false,
  };
}

test("debounce is 300–400ms", () => {
  assert.ok(MARKETPLACE_DEBOUNCE_MS >= 300 && MARKETPLACE_DEBOUNCE_MS <= 400);
});

test("empty vs failure: timeout is not a valid empty catalog", () => {
  assert.equal(
    emptyKindFor({ resultCount: 0, providers: { official: { status: "slow" }, glama: { status: "online" } } }),
    "provider-failure"
  );
  assert.equal(
    emptyKindFor({ resultCount: 0, providers: { official: { status: "online" }, glama: { status: "needs-key" } } }),
    "true-empty"
  );
  assert.equal(
    emptyKindFor({ resultCount: 3, providers: { official: { status: "slow" } } }),
    "results"
  );
});

test("keep previous results while a provider is failing", () => {
  assert.equal(shouldKeepPreviousResults({ incomingCount: 0, emptyKind: "provider-failure", hadResults: true }), true);
  assert.equal(shouldKeepPreviousResults({ incomingCount: 0, emptyKind: "true-empty", hadResults: true }), false);
  assert.equal(shouldKeepPreviousResults({ incomingCount: 4, emptyKind: "results", hadResults: true }), false);
  const kept = mergeCatalogPreferIncoming([server("a")], [], true);
  assert.equal(kept[0].name, "a");
});

test("degraded banner is subtle, not a blank-state timeout", () => {
  assert.match(
    degradedBanner({ official: { status: "slow", name: "Official" }, glama: { status: "online", name: "Glama" } }) ?? "",
    /responding slowly|available sources/i
  );
  assert.match(
    degradedBanner({ official: { status: "offline", name: "Official" }, glama: { status: "offline", name: "Glama" } }, true) ?? "",
    /offline|cached/i
  );
  assert.match(
    degradedBanner({ official: { status: "auth-required", name: "Cloud" }, glama: { status: "online", name: "Glama" } }) ?? "",
    /attention/i
  );
});

test("stale search generation ignores obsolete responses", () => {
  const gen = { current: 0 };
  const first = ++gen.current;
  const second = ++gen.current;
  assert.equal(latestOnly(gen, first, "old"), undefined);
  assert.equal(latestOnly(gen, second, "github"), "github");
});

test("provider dots stay compact", () => {
  const dots = providerDots({ official: { status: "online" }, glama: { status: "needs-key" }, smithery: { status: "offline" } });
  assert.deepEqual(dots.map((d) => d.label), ["Official", "Glama", "Smithery"]);
  assert.equal(dots[0].filled, true);
  assert.equal(dots[1].filled, false);
});
