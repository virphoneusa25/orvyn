// apps/backend/src/persistence/TenantStore.cutover.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createTenantStore,
  persistenceDriver,
} from "./TenantStore";

const pgUrl = process.env.ORVYN_POSTGRES_TEST_URL;

function saveEnv(keys: string[]) {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("persistence driver defaults to sqlite", async () => {
  const restore = saveEnv(["ORVYN_PERSISTENCE_DRIVER"]);
  const dir = mkdtempSync(join(tmpdir(), "orvyn-store-sqlite-"));
  try {
    delete process.env.ORVYN_PERSISTENCE_DRIVER;
    assert.equal(persistenceDriver(), "sqlite");
    const store = await createTenantStore("cutover-sqlite", { dataDir: dir });
    assert.equal(store.driver, "sqlite");
    assert.equal(await store.health(), true);
    await store.close();
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postgres driver fails closed without explicit cutover confirmation", async () => {
  const restore = saveEnv([
    "ORVYN_PERSISTENCE_DRIVER",
    "ORVYN_POSTGRES_CUTOVER_CONFIRMED",
    "ORVYN_POSTGRES_SHADOW",
    "DATABASE_URL",
  ]);
  try {
    process.env.ORVYN_PERSISTENCE_DRIVER = "postgres";
    process.env.ORVYN_POSTGRES_CUTOVER_CONFIRMED = "0";
    process.env.ORVYN_POSTGRES_SHADOW = "0";
    process.env.DATABASE_URL = pgUrl || "postgresql://unused";

    await assert.rejects(
      () => createTenantStore("cutover-unconfirmed"),
      /ORVYN_POSTGRES_CUTOVER_CONFIRMED=1/
    );
  } finally {
    restore();
  }
});

test("postgres primary refuses simultaneous shadow mode", async () => {
  const restore = saveEnv([
    "ORVYN_PERSISTENCE_DRIVER",
    "ORVYN_POSTGRES_CUTOVER_CONFIRMED",
    "ORVYN_POSTGRES_SHADOW",
    "DATABASE_URL",
  ]);
  try {
    process.env.ORVYN_PERSISTENCE_DRIVER = "postgres";
    process.env.ORVYN_POSTGRES_CUTOVER_CONFIRMED = "1";
    process.env.ORVYN_POSTGRES_SHADOW = "1";
    process.env.DATABASE_URL = pgUrl || "postgresql://unused";

    await assert.rejects(
      () => createTenantStore("cutover-dual-mode"),
      /cannot run with ORVYN_POSTGRES_SHADOW=1/
    );
  } finally {
    restore();
  }
});

test(
  "real Postgres: confirmed primary driver creates a healthy PostgreSQL tenant store",
  { skip: !pgUrl },
  async () => {
    const restore = saveEnv([
      "ORVYN_PERSISTENCE_DRIVER",
      "ORVYN_POSTGRES_CUTOVER_CONFIRMED",
      "ORVYN_POSTGRES_SHADOW",
      "DATABASE_URL",
    ]);
    try {
      process.env.ORVYN_PERSISTENCE_DRIVER = "postgres";
      process.env.ORVYN_POSTGRES_CUTOVER_CONFIRMED = "1";
      process.env.ORVYN_POSTGRES_SHADOW = "0";
      process.env.DATABASE_URL = pgUrl!;

      const store = await createTenantStore("cutover-confirmed");
      assert.equal(store.driver, "postgres");
      assert.equal(await store.health(), true);
      await store.close();
    } finally {
      restore();
    }
  }
);
