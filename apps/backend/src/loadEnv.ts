// apps/backend/src/loadEnv.ts
// Loads a gitignored .env from the repo root or cwd so MODEL_API_KEY
// (and friends) are available before ModelService seeds providers.
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function apply(file: string): boolean {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

apply(resolve(process.cwd(), ".env"));
apply(resolve(process.cwd(), "../../.env"));
apply(resolve(__dirname, "../../../.env"));
