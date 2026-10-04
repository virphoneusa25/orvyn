// apps/backend/src/billing/CreditLedgerService.integration.test.ts

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { postgresMirror } from "../persistence/PostgresMirror";
import {
  CreditLedgerService,
  InsufficientCreditsError,
} from "./CreditLedgerService";

const enabled =
  process.env.ORVYN_CREDITS_ENABLED === "1" &&
  Boolean(process.env.DATABASE_URL);

const service = new CreditLedgerService();

async function tenant(prefix: string): Promise<string> {
  const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await postgresMirror.upsertTenant(id, prefix);
  return id;
}

test(
  "real Postgres: grant/reserve/settle is idempotent and spends earliest-expiring credits first",
  { skip: !enabled },
  async () => {
    const tenantId = await tenant("credits_order");
    const soon = Date.now() + 60_000;
    const later = Date.now() + 120_000;

    const first = await service.grant({
      tenantId,
      credits: 100,
      source: "test",
      expiresAt: soon,
      externalRef: "grant-first-" + tenantId,
    });
    const second = await service.grant({
      tenantId,
      credits: 100,
      source: "test",
      expiresAt: later,
      externalRef: "grant-second-" + tenantId,
    });

    const duplicate = await service.grant({
      tenantId,
      credits: 100,
      source: "test",
      expiresAt: soon,
      externalRef: "grant-first-" + tenantId,
    });
    assert.equal(duplicate.id, first.id);

    const initial = await service.balance(tenantId);
    assert.equal(initial.available, 200n);
    assert.equal(initial.reserved, 0n);
    assert.equal(initial.total, 200n);

    const reservationId = "res_" + tenantId;
    const reserved = await service.reserve({
      tenantId,
      reservationId,
      credits: 150,
    });
    assert.equal(reserved.status, "reserved");
    assert.equal(reserved.reservedCredits, 150n);

    const duplicateReserve = await service.reserve({
      tenantId,
      reservationId,
      credits: 150,
    });
    assert.equal(duplicateReserve.id, reservationId);
    assert.equal(duplicateReserve.reservedCredits, 150n);

    const during = await service.balance(tenantId);
    assert.equal(during.available, 50n);
    assert.equal(during.reserved, 150n);
    assert.equal(during.total, 200n);

    const settled = await service.settle({
      tenantId,
      reservationId,
      actualCredits: 120,
    });
    assert.equal(settled.status, "settled");
    assert.equal(settled.settledCredits, 120n);

    const repeated = await service.settle({
      tenantId,
      reservationId,
      actualCredits: 120,
    });
    assert.equal(repeated.status, "settled");

    await assert.rejects(
      () =>
        service.settle({
          tenantId,
          reservationId,
          actualCredits: 119,
        }),
      /different amount/
    );

    const buckets = await service.listBuckets(tenantId);
    const firstAfter = buckets.find((bucket) => bucket.id === first.id);
    const secondAfter = buckets.find((bucket) => bucket.id === second.id);

    assert.equal(firstAfter?.balanceCredits, 0n);
    assert.equal(firstAfter?.reservedCredits, 0n);
    assert.equal(secondAfter?.balanceCredits, 80n);
    assert.equal(secondAfter?.reservedCredits, 0n);

    const final = await service.balance(tenantId);
    assert.equal(final.available, 80n);
    assert.equal(final.reserved, 0n);
    assert.equal(final.total, 80n);

    const ledger = await service.listLedger(tenantId, 100);
    assert.equal(
      ledger.filter((entry) => entry.type === "grant").length,
      2,
      "idempotent externalRef must not create a second grant"
    );
    assert.equal(
      ledger.filter((entry) => entry.type === "reserve").length,
      2,
      "reservation spans two buckets exactly once"
    );
    assert.equal(
      ledger.filter((entry) => entry.type === "settle").reduce(
        (sum, entry) => sum + entry.credits,
        0n
      ),
      120n
    );
    assert.equal(
      ledger.filter((entry) => entry.type === "release").reduce(
        (sum, entry) => sum + entry.credits,
        0n
      ),
      30n
    );
  }
);

test(
  "real Postgres: concurrent reservations cannot overspend one wallet",
  { skip: !enabled },
  async () => {
    const tenantId = await tenant("credits_concurrent");
    await service.grant({
      tenantId,
      credits: 100,
      source: "test",
      externalRef: "seed-" + tenantId,
    });

    const results = await Promise.allSettled([
      service.reserve({
        tenantId,
        reservationId: "res-a-" + tenantId,
        credits: 80,
      }),
      service.reserve({
        tenantId,
        reservationId: "res-b-" + tenantId,
        credits: 80,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason instanceof InsufficientCreditsError, true);

    const balance = await service.balance(tenantId);
    assert.equal(balance.available, 20n);
    assert.equal(balance.reserved, 80n);
    assert.equal(balance.total, 100n);

    await service.release({
      tenantId,
      reservationId: fulfilled[0]!.value.id,
    });
    const released = await service.balance(tenantId);
    assert.equal(released.available, 100n);
    assert.equal(released.reserved, 0n);
  }
);

test(
  "real Postgres: release is idempotent and settled reservations cannot be released",
  { skip: !enabled },
  async () => {
    const tenantId = await tenant("credits_release");
    await service.grant({
      tenantId,
      credits: 50,
      source: "test",
      externalRef: "seed-" + tenantId,
    });

    const releaseId = "release-" + tenantId;
    await service.reserve({
      tenantId,
      reservationId: releaseId,
      credits: 30,
    });

    const first = await service.release({
      tenantId,
      reservationId: releaseId,
    });
    const second = await service.release({
      tenantId,
      reservationId: releaseId,
    });
    assert.equal(first.status, "released");
    assert.equal(second.status, "released");

    const settleId = "settle-" + tenantId;
    await service.reserve({
      tenantId,
      reservationId: settleId,
      credits: 20,
    });
    await service.settle({
      tenantId,
      reservationId: settleId,
      actualCredits: 20,
    });
    await assert.rejects(
      () => service.release({ tenantId, reservationId: settleId }),
      /cannot be released/
    );
  }
);

test(
  "real Postgres: credit ledger is append-only at the database layer",
  { skip: !enabled },
  async () => {
    const tenantId = await tenant("credits_immutable");
    await service.grant({
      tenantId,
      credits: 25,
      source: "test",
      externalRef: "immutable-" + tenantId,
    });

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const row = await pool.query<{ id: string }>(
        "SELECT id FROM credit_ledger WHERE tenant_id=$1 LIMIT 1",
        [tenantId]
      );
      const id = row.rows[0]?.id;
      assert.ok(id);

      await assert.rejects(
        () =>
          pool.query(
            "UPDATE credit_ledger SET credits=999 WHERE id=$1",
            [id]
          ),
        /append-only/
      );
      await assert.rejects(
        () => pool.query("DELETE FROM credit_ledger WHERE id=$1", [id]),
        /append-only/
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "real Postgres: credit inputs reject fractional and invalid amounts",
  { skip: !enabled },
  async () => {
    const tenantId = await tenant("credits_integer");
    await assert.rejects(
      () =>
        service.grant({
          tenantId,
          credits: 1.5,
          source: "test",
        }),
      /safe integer/
    );
    await assert.rejects(
      () =>
        service.grant({
          tenantId,
          credits: "1.5",
          source: "test",
        }),
      /integer/
    );
  }
);

after(async () => {
  await service.close();
});
