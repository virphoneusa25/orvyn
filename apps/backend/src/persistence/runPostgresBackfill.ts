// apps/backend/src/persistence/runPostgresBackfill.ts
//
// CLI:
//   DATABASE_URL=postgresql://... ORVYN_DATA_DIR=/data //     node dist/persistence/runPostgresBackfill.js
//
// Exits non-zero if any tenant has a count mismatch.

import { backfillAllTenants } from "./PostgresBackfill";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const results = await backfillAllTenants({
    connectionString,
    dataDir: process.env.ORVYN_DATA_DIR?.trim() || undefined,
  });

  if (results.length === 0) {
    console.log("No tenant SQLite databases found; nothing to backfill.");
    return;
  }

  let failed = false;
  for (const result of results) {
    console.log(
      JSON.stringify({
        tenantId: result.tenantId,
        sqlite: result.sqlite,
        postgres: result.postgres,
        content: result.content,
        fingerprints: result.fingerprints,
        matches: result.matches,
      })
    );
    if (!result.matches) failed = true;
  }

  if (failed) {
    process.exitCode = 2;
    console.error("PostgreSQL backfill parity FAILED for one or more tenants.");
  } else {
    console.log(`PostgreSQL backfill parity passed for ${results.length} tenant(s).`);
  }
}

void main().catch((err) => {
  console.error(`PostgreSQL backfill failed: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
