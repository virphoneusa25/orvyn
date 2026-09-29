#!/usr/bin/env node
// infrastructure/ovh/backup-data.mjs — consistent SQLite snapshots + verification.
//
// ORVYN keeps accounts, the credit ledger, payments and every tenant's
// sessions/memory in SQLite files under ORVYN_DATA_DIR. Copying a live
// SQLite file (WAL mode) can produce a corrupt copy, so this script takes
// each database's snapshot with `VACUUM INTO` (a transactionally consistent
// copy) and records a manifest (integrity result + row counts per table).
//
//   node backup-data.mjs snapshot --data /data --out /data/.backup-staging/<stamp>
//   node backup-data.mjs verify   --dir <restored-or-staged sqlite dir> [--manifest file]
//   node backup-data.mjs restore  --from <dir with sqlite/> --data <empty target dir>
//
// No dependencies beyond Node 22 (node:sqlite). Never prints row contents.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

function isSqlite(file) {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    return buf.toString("latin1") === "SQLite format 3\u0000";
  } catch { return false; }
}

function walk(dir, skip = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (skip.some((s) => full.startsWith(s))) continue;
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full, skip));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function describe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0] ?? "");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const rows = {};
    for (const t of tables) rows[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t.replaceAll('"', '""')}"`).get().n);
    return { integrity, rows };
  } finally { db.close(); }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (cmd === "snapshot") {
  const data = opt("data"); const out = opt("out");
  if (!data || !out) { console.error("usage: snapshot --data DIR --out DIR"); process.exit(2); }
  const sqliteOut = join(out, "sqlite");
  mkdirSync(sqliteOut, { recursive: true });
  const files = walk(data, [out, join(data, ".backup-staging")]).filter((f) => !/-(wal|shm|journal)$/.test(f) && isSqlite(f));
  const manifest = { createdAt: new Date().toISOString(), dataDir: data, databases: [] };
  for (const f of files) {
    const rel = relative(data, f);
    const dest = join(sqliteOut, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const src = new DatabaseSync(f);
    try {
      src.exec("PRAGMA busy_timeout = 10000");
      src.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
    } finally { src.close(); }
    const info = describe(dest);
    if (info.integrity !== "ok") { console.error(`integrity check failed for ${rel}`); process.exit(1); }
    manifest.databases.push({ path: rel, bytes: statSync(dest).size, sha256: sha256(dest), rows: info.rows });
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`snapshot: ${manifest.databases.length} database(s) → ${out}`);
} else if (cmd === "verify") {
  const dir = opt("dir"); const manifestPath = opt("manifest") ?? join(dir ?? "", "..", "manifest.json");
  if (!dir || !existsSync(manifestPath)) { console.error("usage: verify --dir SQLITE_DIR [--manifest FILE]"); process.exit(2); }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let bad = 0;
  for (const d of manifest.databases) {
    const f = join(dir, d.path);
    if (!existsSync(f)) { console.error(`missing: ${d.path}`); bad++; continue; }
    if (!flag("no-hash") && sha256(f) !== d.sha256) { console.error(`checksum mismatch: ${d.path}`); bad++; continue; }
    const info = describe(f);
    if (info.integrity !== "ok") { console.error(`integrity: ${d.path}: ${info.integrity}`); bad++; continue; }
    for (const [t, n] of Object.entries(d.rows)) {
      if (info.rows[t] !== n) { console.error(`row count: ${d.path}.${t}: ${info.rows[t]} ≠ ${n}`); bad++; }
    }
  }
  console.log(bad ? `verify: FAILED (${bad} problem(s))` : `verify: OK (${manifest.databases.length} database(s), integrity + checksums + row counts)`);
  process.exit(bad ? 1 : 0);
} else if (cmd === "restore") {
  const from = opt("from"); const data = opt("data");
  if (!from || !data) { console.error("usage: restore --from BACKUP_DIR --data TARGET_DIR [--force]"); process.exit(2); }
  mkdirSync(data, { recursive: true });
  if (readdirSync(data).length && !flag("force")) { console.error(`refusing: ${data} is not empty (pass --force to overwrite)`); process.exit(1); }
  const src = join(from, "sqlite");
  let n = 0;
  for (const f of walk(src)) {
    const dest = join(data, relative(src, f));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f, dest);
    n++;
  }
  console.log(`restore: ${n} database(s) → ${data}`);
} else {
  console.error("usage: backup-data.mjs snapshot|verify|restore …");
  process.exit(2);
}
