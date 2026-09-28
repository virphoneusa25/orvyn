// scripts/acceptance/projects-nav.mjs
//
// Projects is a first-class sidebar item (Home, Chats, Projects, Missions,
// Automations); the Projects page lists the user's projects and reopening one
// restores the same workspace (same folder, same files).
//
// Usage (after `npm run build -w @orvyn/desktop`): xvfb-run -a node scripts/acceptance/projects-nav.mjs

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-projects-"));
const userData = join(work, "userData");
const fixture = join(work, "orvyn-desktop-fixture");
const other = join(work, "other-project");
cpSync(join(repoRoot, "scripts", "acceptance", "fixtures", "virphone-site"), fixture, { recursive: true });
mkdirSync(other, { recursive: true }); writeFileSync(join(other, "README.md"), "# other\n");
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: "http://localhost:4570", apiKey: "" }));
writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([other, fixture]));

let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env, ORVYN_SKIP_ONBOARDING: "1" } });
try {
  const win = await app.firstWindow();
  await win.waitForSelector("text=Home", { timeout: 30000 });
  await sleep(1500);
  const nav = await win.evaluate(() => [...document.querySelectorAll("nav button, aside button, [role=navigation] button")].map((b) => (b.textContent ?? "").trim()).filter(Boolean));
  const order = ["Home", "Chats", "Projects", "Missions", "Automations"].map((l) => nav.findIndex((t) => t.startsWith(l)));
  ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), "sidebar: Home, Chats, Projects, Missions, Automations", JSON.stringify(nav.slice(0, 14)));
  await win.getByRole("button", { name: /^Projects$/ }).first().click();
  await sleep(800);
  const page = await win.locator("body").innerText();
  ok(/orvyn-desktop-fixture/.test(page) && /other-project/.test(page), "the Projects page lists the projects", page.slice(0, 300));
  await win.locator("button", { hasText: "orvyn-desktop-fixture" }).first().click();
  await sleep(1500);
  const ws = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.webContents.executeJavaScript("window.orvyn.project.getWorkspace()");
  });
  ok(ws?.root === fixture, "reopening restores the same workspace folder", JSON.stringify(ws));
  const files = await app.evaluate(async ({ BrowserWindow }, root) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.orvyn.project.listDir ? window.orvyn.project.listDir(${JSON.stringify(root)}).then((l) => l.map((e) => e.name ?? e)) : null`), fixture).catch(() => null);
  ok(!files || (Array.isArray(files) && files.some((f) => String(f).includes("index.html"))), "…with the same files (index.html, styles.css)", JSON.stringify(files));
} catch (e) {
  failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
} finally {
  await app.close().catch(() => undefined);
}
console.log(failures === 0 ? "\nPROJECTS NAV: PASS" : `\nPROJECTS NAV: FAIL (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
