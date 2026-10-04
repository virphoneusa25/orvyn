// apps/backend/src/persistence/runPostgresParity.ts
//
// Read-only cutover gate:
//   DATABASE_URL=postgresql://... ORVYN_DATA_DIR=/data //     node dist/persistence/runPostgresParity.js

import { verifyAllTenants } from "./PostgresBackfill";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const results = await verifyAllTenants({
    connectionString,
    dataDir: process.env.ORVYN_DATA_DIR?.trim() || undefined,
  });

  if (results.length === 0) {
    console.log("No tenant SQLite databases found; nothing to verify.");
    return;
  }

  let failed = false;
  for (const result of results) {
    console.log(JSON.stringify({
      tenantId: result.tenantId,
      sqlite: result.sqlite,
      postgres: result.postgres,
      content: result.content,
      fingerprints: result.fingerprints,
      matches: result.matches,
    }));
    if (!result.matches) failed = true;
  }

  if (failed) {
    console.error("PostgreSQL cutover parity FAILED.");
    process.exitCode = 2;
  } else {
    console.log(`PostgreSQL cutover parity passed for ${results.length} tenant(s).`);
  }
}

void main().catch((err) => {
  console.error(`PostgreSQL parity verification failed: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
