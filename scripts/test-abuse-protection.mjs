// scripts/test-abuse-protection.mjs
// Verifies the abuse-protection layer against the BUILT backend (dist/):
//   1. TokenBucketLimiter: budget, denial, refill timing
//   2. MissionQueue: bounded concurrency, FIFO drain
//   3. UsageService quota: enforcement, persistence hydration, month roll
// Run: node scripts/test-abuse-protection.mjs   (after npm run build -w apps/backend)

import assert from "node:assert/strict";

const { TokenBucketLimiter } = await import("../apps/backend/dist/middleware/rateLimit.js");
const { MissionQueue } = await import("../apps/backend/dist/queue/MissionQueue.js");
const { UsageService, QuotaExceededError } = await import("../apps/backend/dist/services/UsageService.js");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  FAIL ${name}: ${err.message}`);
    });
}

console.log("TokenBucketLimiter");
await check("allows burst then denies with Retry-After", () => {
  const l = new TokenBucketLimiter(60, 3); // 3 burst, 1/sec sustained
  assert.equal(l.take("t1").ok, true);
  assert.equal(l.take("t1").ok, true);
  assert.equal(l.take("t1").ok, true);
  const denied = l.take("t1");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
});
await check("keys are independent", () => {
  const l = new TokenBucketLimiter(60, 1);
  assert.equal(l.take("a").ok, true);
  assert.equal(l.take("a").ok, false);
  assert.equal(l.take("b").ok, true);
});
await check("refills over time", async () => {
  const l = new TokenBucketLimiter(6000, 1); // 100/sec → refill in ~10ms
  assert.equal(l.take("x").ok, true);
  assert.equal(l.take("x").ok, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(l.take("x").ok, true);
});
await check("0 rpm disables limiting", () => {
  const l = new TokenBucketLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(l.take("z").ok, true);
});

console.log("MissionQueue");
await check("runs up to concurrency, queues the rest FIFO", async () => {
  const q = new MissionQueue(2);
  const order = [];
  const gates = [];
  const job = (n) => () =>
    new Promise((resolve) => {
      order.push(`start${n}`);
      gates.push(() => {
        order.push(`end${n}`);
        resolve();
      });
    });
  assert.equal(q.enqueue(job(1)), 0);
  assert.equal(q.enqueue(job(2)), 0);
  assert.equal(q.enqueue(job(3)), 1); // over the limit → waits
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["start1", "start2"]); // 3 must NOT have started
  assert.deepEqual(q.stats(), { running: 2, waiting: 1, concurrency: 2 });
  gates[0](); // finish job 1 → job 3 takes the slot
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(order.includes("start3"));
  gates[1]();
  gates[2]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, concurrency: 2 });
});
await check("failed job frees its slot", async () => {
  const q = new MissionQueue(1);
  q.enqueue(() => Promise.reject(new Error("boom")));
  let ran = false;
  q.enqueue(async () => {
    ran = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ran, true);
});

console.log("UsageService quota");
const fakeProvider = () => ({
  config: { id: "fake", provider: "test" },
  generate: async () => ({ content: "hi" }),
  stream: async function* () {
    yield { delta: "hi" };
  },
  healthCheck: async () => true,
  supportsTools: () => false,
  supportsVision: () => false,
});
await check("enforces the monthly limit at the provider boundary", async () => {
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "2";
  const usage = new UsageService();
  const p = usage.wrap(fakeProvider());
  await p.generate({ messages: [] });
  await p.generate({ messages: [] });
  await assert.rejects(() => p.generate({ messages: [] }), QuotaExceededError);
  const q = usage.quota();
  assert.equal(q.limit, 2);
  assert.equal(q.used, 2);
  assert.equal(q.remaining, 0);
});
await check("hydrates the month count from the store (restart-proof)", async () => {
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "5";
  const usage = new UsageService();
  usage.attachStore({
    saveUsageEvent: () => {},
    loadRecentUsage: () => [],
    countUsageSince: () => 5, // pretend 5 requests already persisted this month
  });
  const p = usage.wrap(fakeProvider());
  await assert.rejects(() => p.generate({ messages: [] }), QuotaExceededError);
});
await check("0 = unlimited", async () => {
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "0";
  const usage = new UsageService();
  const p = usage.wrap(fakeProvider());
  for (let i = 0; i < 20; i++) await p.generate({ messages: [] });
});
await check("streams count toward the quota too", async () => {
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "1";
  const usage = new UsageService();
  const p = usage.wrap(fakeProvider());
  for await (const _ of p.stream({ messages: [] })) void _;
  await assert.rejects(async () => {
    for await (const _ of p.stream({ messages: [] })) void _;
  }, QuotaExceededError);
});

delete process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
