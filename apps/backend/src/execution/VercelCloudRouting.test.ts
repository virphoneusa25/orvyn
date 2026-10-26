// apps/backend/src/execution/VercelCloudRouting.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionRouter } from "./ExecutionRouter";

const KEYS = [
  "ORVYN_CLOUD_EXECUTION_PROVIDER",
  "SANDBOX_VERCEL_TOKEN",
  "SANDBOX_VERCEL_TEAM_ID",
  "SANDBOX_VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

async function withEnv(
  values: Partial<Record<(typeof KEYS)[number], string>>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    await fn();
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("ORVYN Cloud defaults to the legacy provider during migration", async () => {
  await withEnv({}, async () => {
    const router = new ExecutionRouter();
    assert.equal(
      process.env.ORVYN_CLOUD_EXECUTION_PROVIDER,
      undefined,
      "provider choice remains implicit unless explicitly configured"
    );
    await router.dispose();
  });
});

test("explicit Vercel cloud selection fails closed when Vercel credentials are missing", async () => {
  await withEnv(
    { ORVYN_CLOUD_EXECUTION_PROVIDER: "vercel" },
    async () => {
      const router = new ExecutionRouter();

      await assert.rejects(
        () =>
          router.select({
            preference: "VERCEL_CLOUD",
          }),
        /Vercel ORVYN Cloud unavailable|Vercel Sandbox credentials/i
      );

      await router.dispose();
    }
  );
});
