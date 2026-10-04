// apps/backend/src/billing/CreditLedgerService.ts
//
// Commercial credit wallet foundation. This layer intentionally knows nothing
// about Stripe prices or plan names. Payment/subscription systems grant credits
// into this ledger; they never mutate balances directly.

import { randomUUID } from "crypto";
import { Pool, PoolClient } from "pg";

export type CreditReservationStatus = "reserved" | "settled" | "released";

export interface CreditBalance {
  tenantId: string;
  available: bigint;
  reserved: bigint;
  total: bigint;
}

export interface CreditBucket {
  id: string;
  tenantId: string;
  source: string;
  grantedCredits: bigint;
  balanceCredits: bigint;
  reservedCredits: bigint;
  expiresAt: number | null;
  createdAt: number;
}

export interface CreditReservation {
  id: string;
  tenantId: string;
  requestedCredits: bigint;
  reservedCredits: bigint;
  settledCredits: bigint | null;
  status: CreditReservationStatus;
  createdAt: number;
  updatedAt: number;
}

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly requested: bigint,
    public readonly available: bigint
  ) {
    super(
      "Insufficient credits: requested " +
        requested.toString() +
        ", available " +
        available.toString()
    );
    this.name = "InsufficientCreditsError";
  }
}

const SCHEMA_V2: string[] = [
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS credit_wallets (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS credit_buckets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES credit_wallets(tenant_id) ON DELETE CASCADE, source TEXT NOT NULL, granted_credits BIGINT NOT NULL CHECK (granted_credits > 0), balance_credits BIGINT NOT NULL CHECK (balance_credits >= 0), reserved_credits BIGINT NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0), expires_at BIGINT, created_at BIGINT NOT NULL, CHECK (reserved_credits <= balance_credits))",
  "CREATE INDEX IF NOT EXISTS idx_credit_buckets_spend ON credit_buckets (tenant_id, expires_at, created_at, id)",
  "CREATE TABLE IF NOT EXISTS credit_reservations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES credit_wallets(tenant_id) ON DELETE CASCADE, requested_credits BIGINT NOT NULL CHECK (requested_credits > 0), reserved_credits BIGINT NOT NULL CHECK (reserved_credits > 0), settled_credits BIGINT CHECK (settled_credits >= 0), status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_credit_reservations_tenant ON credit_reservations (tenant_id, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS credit_reservation_allocations (reservation_id TEXT NOT NULL REFERENCES credit_reservations(id) ON DELETE RESTRICT, bucket_id TEXT NOT NULL REFERENCES credit_buckets(id) ON DELETE RESTRICT, reserved_credits BIGINT NOT NULL CHECK (reserved_credits > 0), settled_credits BIGINT NOT NULL DEFAULT 0 CHECK (settled_credits >= 0), PRIMARY KEY (reservation_id, bucket_id), CHECK (settled_credits <= reserved_credits))",
  "CREATE TABLE IF NOT EXISTS credit_ledger (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES credit_wallets(tenant_id) ON DELETE RESTRICT, bucket_id TEXT REFERENCES credit_buckets(id) ON DELETE RESTRICT, reservation_id TEXT REFERENCES credit_reservations(id) ON DELETE RESTRICT, entry_type TEXT NOT NULL CHECK (entry_type IN ('grant','reserve','settle','release','expire','adjustment')), credits BIGINT NOT NULL CHECK (credits >= 0), external_ref TEXT, metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger (tenant_id, created_at DESC, id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_external_ref ON credit_ledger (tenant_id, external_ref) WHERE external_ref IS NOT NULL",
  "CREATE OR REPLACE FUNCTION orvyn_credit_ledger_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'credit_ledger is append-only'; END; $$ LANGUAGE plpgsql",
  "DROP TRIGGER IF EXISTS credit_ledger_no_update ON credit_ledger",
  "CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION orvyn_credit_ledger_immutable()",
];

function asBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Credit amount must be a safe integer");
    return BigInt(value);
  }
  if (!/^-?\\d+$/.test(value)) throw new Error("Credit amount must be an integer");
  return BigInt(value);
}

function positive(value: string | number | bigint, label: string): bigint {
  const n = asBigInt(value);
  if (n <= 0n) throw new Error(label + " must be greater than zero");
  return n;
}

export class CreditLedgerService {
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;

  isEnabled(): boolean {
    return (
      process.env.ORVYN_CREDITS_ENABLED?.trim() === "1" &&
      Boolean(process.env.DATABASE_URL?.trim())
    );
  }

  private getPool(): Pool {
    if (!this.pool) {
      if (!this.isEnabled()) throw new Error("ORVYN credit ledger is disabled");
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Math.max(1, Number(process.env.ORVYN_POSTGRES_POOL_MAX) || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl:
          process.env.ORVYN_POSTGRES_SSL?.trim().toLowerCase() === "disable"
            ? false
            : undefined,
        application_name: "orvyn-credits",
      });
    }
    return this.pool;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        for (const statement of SCHEMA_V2) await client.query(statement);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT(version) DO NOTHING"
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  private async ready(): Promise<Pool> {
    await this.init();
    return this.getPool();
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await (await this.ready()).connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async ensureWallet(client: PoolClient, tenantId: string): Promise<void> {
    const now = Date.now();
    await client.query(
      "INSERT INTO credit_wallets(tenant_id,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT(tenant_id) DO NOTHING",
      [tenantId, now]
    );
    // One wallet row lock serializes all money-changing operations for this
    // tenant. This is intentionally simple and correctness-first.
    await client.query(
      "SELECT tenant_id FROM credit_wallets WHERE tenant_id=$1 FOR UPDATE",
      [tenantId]
    );
  }

  private async expireAvailable(client: PoolClient, tenantId: string): Promise<void> {
    const now = Date.now();
    const result = await client.query<{
      id: string;
      balance_credits: string;
      reserved_credits: string;
    }>(
      "SELECT id,balance_credits::text,reserved_credits::text FROM credit_buckets WHERE tenant_id=$1 AND expires_at IS NOT NULL AND expires_at <= $2 AND balance_credits > reserved_credits ORDER BY id FOR UPDATE",
      [tenantId, now]
    );
    for (const row of result.rows) {
      const amount = BigInt(row.balance_credits) - BigInt(row.reserved_credits);
      if (amount <= 0n) continue;
      await client.query(
        "UPDATE credit_buckets SET balance_credits=balance_credits-$2 WHERE id=$1",
        [row.id, amount.toString()]
      );
      await client.query(
        "INSERT INTO credit_ledger(id,tenant_id,bucket_id,entry_type,credits,created_at) VALUES ($1,$2,$3,'expire',$4,$5)",
        ["led_" + randomUUID(), tenantId, row.id, amount.toString(), now]
      );
    }
  }

  async grant(input: {
    tenantId: string;
    credits: string | number | bigint;
    source: string;
    expiresAt?: number | null;
    externalRef?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditBucket> {
    const amount = positive(input.credits, "credits");
    const source = input.source.trim();
    if (!source) throw new Error("source is required");

    return this.tx(async (client) => {
      await this.ensureWallet(client, input.tenantId);

      if (input.externalRef) {
        const prior = await client.query<{ bucket_id: string | null }>(
          "SELECT bucket_id FROM credit_ledger WHERE tenant_id=$1 AND external_ref=$2 LIMIT 1",
          [input.tenantId, input.externalRef]
        );
        if (prior.rows[0]?.bucket_id) {
          const existing = await this.bucket(client, prior.rows[0].bucket_id);
          if (existing) return existing;
        }
      }

      const id = "cb_" + randomUUID();
      const now = Date.now();
      await client.query(
        "INSERT INTO credit_buckets(id,tenant_id,source,granted_credits,balance_credits,reserved_credits,expires_at,created_at) VALUES ($1,$2,$3,$4,$4,0,$5,$6)",
        [id, input.tenantId, source, amount.toString(), input.expiresAt ?? null, now]
      );
      await client.query(
        "INSERT INTO credit_ledger(id,tenant_id,bucket_id,entry_type,credits,external_ref,metadata_json,created_at) VALUES ($1,$2,$3,'grant',$4,$5,$6::jsonb,$7)",
        [
          "led_" + randomUUID(),
          input.tenantId,
          id,
          amount.toString(),
          input.externalRef ?? null,
          JSON.stringify(input.metadata ?? {}),
          now,
        ]
      );
      const created = await this.bucket(client, id);
      if (!created) throw new Error("Credit bucket could not be reloaded");
      return created;
    });
  }

  async balance(tenantId: string): Promise<CreditBalance> {
    await this.tx(async (client) => {
      await this.ensureWallet(client, tenantId);
      await this.expireAvailable(client, tenantId);
    });
    const result = await (await this.ready()).query<{
      available: string;
      reserved: string;
      total: string;
    }>(
      "SELECT COALESCE(SUM(balance_credits-reserved_credits),0)::text AS available, COALESCE(SUM(reserved_credits),0)::text AS reserved, COALESCE(SUM(balance_credits),0)::text AS total FROM credit_buckets WHERE tenant_id=$1",
      [tenantId]
    );
    const row = result.rows[0];
    return {
      tenantId,
      available: BigInt(row?.available ?? "0"),
      reserved: BigInt(row?.reserved ?? "0"),
      total: BigInt(row?.total ?? "0"),
    };
  }

  async reserve(input: {
    tenantId: string;
    reservationId: string;
    credits: string | number | bigint;
  }): Promise<CreditReservation> {
    const requested = positive(input.credits, "credits");
    if (!input.reservationId.trim()) throw new Error("reservationId is required");

    return this.tx(async (client) => {
      await this.ensureWallet(client, input.tenantId);
      await this.expireAvailable(client, input.tenantId);

      const prior = await client.query(
        "SELECT * FROM credit_reservations WHERE id=$1 FOR UPDATE",
        [input.reservationId]
      );
      if (prior.rows[0]) {
        const existing = this.reservation(prior.rows[0]);
        if (
          existing.tenantId !== input.tenantId ||
          existing.requestedCredits !== requested
        ) {
          throw new Error("Reservation id already exists with different parameters");
        }
        return existing;
      }

      const buckets = await client.query<{
        id: string;
        balance_credits: string;
        reserved_credits: string;
      }>(
        "SELECT id,balance_credits::text,reserved_credits::text FROM credit_buckets WHERE tenant_id=$1 AND balance_credits > reserved_credits AND (expires_at IS NULL OR expires_at > $2) ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC FOR UPDATE",
        [input.tenantId, Date.now()]
      );
      const available = buckets.rows.reduce(
        (sum, row) =>
          sum + BigInt(row.balance_credits) - BigInt(row.reserved_credits),
        0n
      );
      if (available < requested) {
        throw new InsufficientCreditsError(requested, available);
      }

      const now = Date.now();
      await client.query(
        "INSERT INTO credit_reservations(id,tenant_id,requested_credits,reserved_credits,status,created_at,updated_at) VALUES ($1,$2,$3,$3,'reserved',$4,$4)",
        [input.reservationId, input.tenantId, requested.toString(), now]
      );

      let remaining = requested;
      for (const row of buckets.rows) {
        if (remaining <= 0n) break;
        const availableHere =
          BigInt(row.balance_credits) - BigInt(row.reserved_credits);
        const take = availableHere < remaining ? availableHere : remaining;
        if (take <= 0n) continue;
        await client.query(
          "UPDATE credit_buckets SET reserved_credits=reserved_credits+$2 WHERE id=$1",
          [row.id, take.toString()]
        );
        await client.query(
          "INSERT INTO credit_reservation_allocations(reservation_id,bucket_id,reserved_credits,settled_credits) VALUES ($1,$2,$3,0)",
          [input.reservationId, row.id, take.toString()]
        );
        await client.query(
          "INSERT INTO credit_ledger(id,tenant_id,bucket_id,reservation_id,entry_type,credits,created_at) VALUES ($1,$2,$3,$4,'reserve',$5,$6)",
          [
            "led_" + randomUUID(),
            input.tenantId,
            row.id,
            input.reservationId,
            take.toString(),
            now,
          ]
        );
        remaining -= take;
      }

      const created = await this.reservationById(client, input.reservationId);
      if (!created) throw new Error("Reservation could not be reloaded");
      return created;
    });
  }

  async settle(input: {
    tenantId: string;
    reservationId: string;
    actualCredits: string | number | bigint;
  }): Promise<CreditReservation> {
    const actual = asBigInt(input.actualCredits);
    if (actual < 0n) throw new Error("actualCredits cannot be negative");

    return this.tx(async (client) => {
      await this.ensureWallet(client, input.tenantId);
      const result = await client.query(
        "SELECT * FROM credit_reservations WHERE id=$1 FOR UPDATE",
        [input.reservationId]
      );
      if (!result.rows[0]) throw new Error("Unknown credit reservation");
      const current = this.reservation(result.rows[0]);
      if (current.tenantId !== input.tenantId) {
        throw new Error("Reservation belongs to a different tenant");
      }
      if (current.status === "settled") {
        if (current.settledCredits !== actual) {
          throw new Error("Reservation already settled with a different amount");
        }
        return current;
      }
      if (current.status === "released") {
        throw new Error("Released reservation cannot be settled");
      }
      if (actual > current.reservedCredits) {
        throw new Error("actualCredits exceeds reserved credits");
      }

      const allocations = await client.query<{
        bucket_id: string;
        reserved_credits: string;
      }>(
        "SELECT a.bucket_id,a.reserved_credits::text FROM credit_reservation_allocations a JOIN credit_buckets b ON b.id=a.bucket_id WHERE a.reservation_id=$1 ORDER BY b.expires_at ASC NULLS LAST,b.created_at ASC,b.id ASC FOR UPDATE OF a",
        [input.reservationId]
      );
      const ids = allocations.rows.map((row) => row.bucket_id);
      if (ids.length) {
        await client.query(
          "SELECT id FROM credit_buckets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
          [ids]
        );
      }

      let remaining = actual;
      const now = Date.now();
      for (const allocation of allocations.rows) {
        const reserved = BigInt(allocation.reserved_credits);
        const charge =
          remaining <= 0n ? 0n : reserved < remaining ? reserved : remaining;
        const release = reserved - charge;

        await client.query(
          "UPDATE credit_buckets SET balance_credits=balance_credits-$2, reserved_credits=reserved_credits-$3 WHERE id=$1",
          [allocation.bucket_id, charge.toString(), reserved.toString()]
        );
        await client.query(
          "UPDATE credit_reservation_allocations SET settled_credits=$3 WHERE reservation_id=$1 AND bucket_id=$2",
          [input.reservationId, allocation.bucket_id, charge.toString()]
        );

        if (charge > 0n) {
          await client.query(
            "INSERT INTO credit_ledger(id,tenant_id,bucket_id,reservation_id,entry_type,credits,created_at) VALUES ($1,$2,$3,$4,'settle',$5,$6)",
            [
              "led_" + randomUUID(),
              input.tenantId,
              allocation.bucket_id,
              input.reservationId,
              charge.toString(),
              now,
            ]
          );
        }
        if (release > 0n) {
          await client.query(
            "INSERT INTO credit_ledger(id,tenant_id,bucket_id,reservation_id,entry_type,credits,created_at) VALUES ($1,$2,$3,$4,'release',$5,$6)",
            [
              "led_" + randomUUID(),
              input.tenantId,
              allocation.bucket_id,
              input.reservationId,
              release.toString(),
              now,
            ]
          );
        }
        remaining -= charge;
      }
      if (remaining !== 0n) {
        throw new Error("Reservation allocations do not cover settled credits");
      }

      await client.query(
        "UPDATE credit_reservations SET status='settled',settled_credits=$2,updated_at=$3 WHERE id=$1",
        [input.reservationId, actual.toString(), now]
      );
      const settled = await this.reservationById(client, input.reservationId);
      if (!settled) throw new Error("Settled reservation could not be reloaded");
      return settled;
    });
  }

  async release(input: {
    tenantId: string;
    reservationId: string;
  }): Promise<CreditReservation> {
    return this.tx(async (client) => {
      await this.ensureWallet(client, input.tenantId);
      const result = await client.query(
        "SELECT * FROM credit_reservations WHERE id=$1 FOR UPDATE",
        [input.reservationId]
      );
      if (!result.rows[0]) throw new Error("Unknown credit reservation");
      const current = this.reservation(result.rows[0]);
      if (current.tenantId !== input.tenantId) {
        throw new Error("Reservation belongs to a different tenant");
      }
      if (current.status === "released") return current;
      if (current.status === "settled") {
        throw new Error("Settled reservation cannot be released");
      }

      const allocations = await client.query<{
        bucket_id: string;
        reserved_credits: string;
      }>(
        "SELECT bucket_id,reserved_credits::text FROM credit_reservation_allocations WHERE reservation_id=$1 ORDER BY bucket_id FOR UPDATE",
        [input.reservationId]
      );
      const ids = allocations.rows.map((row) => row.bucket_id);
      if (ids.length) {
        await client.query(
          "SELECT id FROM credit_buckets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
          [ids]
        );
      }

      const now = Date.now();
      for (const allocation of allocations.rows) {
        const amount = BigInt(allocation.reserved_credits);
        await client.query(
          "UPDATE credit_buckets SET reserved_credits=reserved_credits-$2 WHERE id=$1",
          [allocation.bucket_id, amount.toString()]
        );
        await client.query(
          "INSERT INTO credit_ledger(id,tenant_id,bucket_id,reservation_id,entry_type,credits,created_at) VALUES ($1,$2,$3,$4,'release',$5,$6)",
          [
            "led_" + randomUUID(),
            input.tenantId,
            allocation.bucket_id,
            input.reservationId,
            amount.toString(),
            now,
          ]
        );
      }
      await client.query(
        "UPDATE credit_reservations SET status='released',updated_at=$2 WHERE id=$1",
        [input.reservationId, now]
      );

      const released = await this.reservationById(client, input.reservationId);
      if (!released) throw new Error("Released reservation could not be reloaded");
      return released;
    });
  }

  async listBuckets(tenantId: string): Promise<CreditBucket[]> {
    const result = await (await this.ready()).query(
      "SELECT * FROM credit_buckets WHERE tenant_id=$1 ORDER BY expires_at ASC NULLS LAST,created_at ASC,id ASC",
      [tenantId]
    );
    return result.rows.map((row) => this.bucketRow(row));
  }

  async listLedger(tenantId: string, limit = 100) {
    const result = await (await this.ready()).query<{
      id: string;
      bucket_id: string | null;
      reservation_id: string | null;
      entry_type: string;
      credits: string;
      external_ref: string | null;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      "SELECT id,bucket_id,reservation_id,entry_type,credits::text,external_ref,metadata_json,created_at::text FROM credit_ledger WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2",
      [tenantId, Math.max(1, Math.min(limit, 1000))]
    );
    return result.rows.map((row) => ({
      id: row.id,
      bucketId: row.bucket_id,
      reservationId: row.reservation_id,
      type: row.entry_type,
      credits: BigInt(row.credits),
      externalRef: row.external_ref,
      metadata: row.metadata_json ?? {},
      createdAt: Number(row.created_at),
    }));
  }

  private async bucket(
    client: PoolClient,
    id: string
  ): Promise<CreditBucket | null> {
    const result = await client.query(
      "SELECT * FROM credit_buckets WHERE id=$1 LIMIT 1",
      [id]
    );
    return result.rows[0] ? this.bucketRow(result.rows[0]) : null;
  }

  private async reservationById(
    client: PoolClient,
    id: string
  ): Promise<CreditReservation | null> {
    const result = await client.query(
      "SELECT * FROM credit_reservations WHERE id=$1 LIMIT 1",
      [id]
    );
    return result.rows[0] ? this.reservation(result.rows[0]) : null;
  }

  private bucketRow(row: any): CreditBucket {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      source: String(row.source),
      grantedCredits: BigInt(row.granted_credits),
      balanceCredits: BigInt(row.balance_credits),
      reservedCredits: BigInt(row.reserved_credits),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      createdAt: Number(row.created_at),
    };
  }

  private reservation(row: any): CreditReservation {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      requestedCredits: BigInt(row.requested_credits),
      reservedCredits: BigInt(row.reserved_credits),
      settledCredits:
        row.settled_credits == null ? null : BigInt(row.settled_credits),
      status: row.status as CreditReservationStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.initPromise = null;
    if (pool) await pool.end();
  }
}

export const creditLedger = new CreditLedgerService();
