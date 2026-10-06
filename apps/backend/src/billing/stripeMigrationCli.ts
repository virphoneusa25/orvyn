import { readStripeSnapshot } from "./StripeStorageSnapshot";
import { PostgresStripeStorage } from "./PostgresStripeStorage";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--source" || !["--check", "--import", "--verify"].includes(args[2])) {
    throw new Error("Usage: stripeMigrationCli --source PAYMENTS_DB --check|--import|--verify");
  }
  const snapshot = readStripeSnapshot(args[1]);
  const counts = Object.fromEntries(Object.entries(snapshot).filter(([table]) => table !== "__sequences").map(([table, rows]) => [table, rows.length]));
  if (args[2] === "--check") { console.log(JSON.stringify({ mode:"source-check", tables:counts, ready:true })); return; }
  const storage = new PostgresStripeStorage(process.env.ORVYN_PAYMENTS_PG_URL || "");
  try {
    if (args[2] === "--import") {
      await storage.init();
      const imported = await storage.importSnapshot(snapshot);
      const result = await storage.verify(snapshot);
      if (!result.matches) throw new Error("Stripe payment content verification failed");
      console.log(JSON.stringify({ mode:"import", imported:imported.imported, matches:true, tables:result.counts, livePaymentsSwitched:false }));
    } else {
      const result = await storage.verify(snapshot);
      console.log(JSON.stringify({ mode:"verify", matches:result.matches, tables:result.counts, livePaymentsSwitched:false }));
      if (!result.matches) process.exitCode = 1;
    }
  } finally { await storage.close(); }
}

void main().catch(error => {
  // PostgreSQL error details may include credential-bearing rows. Never emit them.
  console.error(JSON.stringify({ error:"Stripe payment migration failed", code:typeof error?.code === "string" ? error.code : "VALIDATION_ERROR" }));
  process.exitCode = 1;
});

