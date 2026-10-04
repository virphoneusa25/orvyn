import { readAuthSnapshot } from "./AuthStorageSnapshot";
import { PostgresAuthStorage } from "./PostgresAuthStorage";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--source" || !["--check", "--import", "--verify"].includes(args[2])) {
    throw new Error("Usage: authMigrationCli --source AUTH_DB --check|--import|--verify");
  }
  const snapshot = readAuthSnapshot(args[1]);
  const counts = Object.fromEntries(Object.entries(snapshot).filter(([table]) => table !== "__sequences").map(([table, rows]) => [table, rows.length]));
  if (args[2] === "--check") { console.log(JSON.stringify({ mode:"source-check", tables:counts, ready:true })); return; }
  const storage = new PostgresAuthStorage(process.env.ORVYN_AUTH_PG_URL || "");
  try {
    if (args[2] === "--import") {
      await storage.init();
      const imported = await storage.importSnapshot(snapshot);
      const result = await storage.verify(snapshot);
      if (!result.matches) throw new Error("Authentication content verification failed");
      console.log(JSON.stringify({ mode:"import", imported:imported.imported, matches:true, tables:result.counts, liveAuthenticationSwitched:false }));
    } else {
      const result = await storage.verify(snapshot);
      console.log(JSON.stringify({ mode:"verify", matches:result.matches, tables:result.counts, liveAuthenticationSwitched:false }));
      if (!result.matches) process.exitCode = 1;
    }
  } finally { await storage.close(); }
}

void main().catch(error => {
  // PostgreSQL error details may include credential-bearing rows. Never emit them.
  console.error(JSON.stringify({ error:"Authentication migration failed", code:typeof error?.code === "string" ? error.code : "VALIDATION_ERROR" }));
  process.exitCode = 1;
});
