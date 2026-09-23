// Builds the Windows installer from this repo and names the exe with the
// commit that was compiled. The status bar shows the same seven characters.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function gitSha() {
  const fromEnv = process.env.ORVYN_BUILD_SHA || process.env.GITHUB_SHA;
  if (fromEnv && fromEnv !== "dev") return fromEnv.trim();
  return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
}

function run(args, cwd = repoRoot) {
  const result = spawnSync(npm, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(path.join(repoRoot, "package.json"))) {
  console.error(`ORVYN repo not found at ${repoRoot}`);
  process.exit(1);
}
if (!existsSync(path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"))) {
  console.error("Dependencies are not installed in this clone.");
  console.error(`From ${repoRoot} run: npm ci`);
  console.error("Or double-click scripts\\build-windows.cmd inside the clone.");
  process.exit(1);
}

const sha = gitSha();
const short = sha.slice(0, 7);
process.env.ORVYN_BUILD_SHA = sha;
process.env.ORVYN_SHORT_SHA = short;

const installerName = `ORVYN Setup 0.1.0-${short}.exe`;
const releaseDir = path.join(repoRoot, "apps", "desktop", "release");
const installer = path.join(releaseDir, installerName);
console.log(`Packaging ORVYN desktop ${short}`);
console.log(`Folder: ${repoRoot}`);

run(["run", "build", "-w", "@orvyn/desktop"]);
run(["run", "build", "-w", "@orvyn/ai-core"]);
run(["run", "build", "-w", "@orvyn/backend"]);

const stage = spawnSync(process.execPath, ["scripts/stage-desktop-backend.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
if (stage.status !== 0) process.exit(stage.status ?? 1);

const builderCli = [
  path.join(repoRoot, "node_modules", "electron-builder", "cli.js"),
  path.join(repoRoot, "apps", "desktop", "node_modules", "electron-builder", "cli.js"),
].find((candidate) => existsSync(candidate));
if (!builderCli) {
  console.error("electron-builder is not installed. Run npm ci in the clone.");
  process.exit(1);
}
const packed = spawnSync(process.execPath, [builderCli, "--win"], {
  cwd: path.join(repoRoot, "apps", "desktop"),
  stdio: "inherit",
  env: process.env,
});
if (packed.status !== 0) process.exit(packed.status ?? 1);

if (!existsSync(installer)) {
  const found = existsSync(releaseDir) ? readdirSync(releaseDir).filter((name) => name.endsWith(".exe")) : [];
  console.error(`Expected installer was not written: ${installer}`);
  console.error(found.length ? `Found: ${found.join(", ")}` : "No .exe files in apps/desktop/release.");
  process.exit(1);
}
const stale = path.join(releaseDir, "ORVYN Setup 0.1.0.exe");
if (existsSync(stale)) unlinkSync(stale);

console.log("");
console.log(`Installer: ${installer}`);
console.log(`Install that file. The status bar must say Desktop ${short}.`);
console.log("Do not install ORVYN Setup 0.1.0.exe. That name is an older build.");
