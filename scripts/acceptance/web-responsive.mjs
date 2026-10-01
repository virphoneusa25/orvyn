import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ownServer = !process.env.ORVYN_WEB_URL;
const origin = process.env.ORVYN_WEB_URL || "http://127.0.0.1:5199";
const screenshotDir = process.env.ORVYN_RESPONSIVE_SCREENSHOTS;
const now = Date.now();
const session = { sessionId: "alpha", title: "Generate an image of a sunrise over snowy mountains", projectId: "p1", projectRoot: null, runIds: [], pinned: false, createdAt: now - 80_000, updatedAt: now, messageCount: 2, lastMessage: "Here is the image and a short summary." };
const project = { id: "p1", name: "Kernel AI Labs Website", projectRoot: null, createdAt: now - 100_000, updatedAt: now, userId: "u1", description: "Product website, launch assets and agent workspace." };
const artifacts = [
  { artifactId: "a1", name: "generated-very-wide-production-homepage-mobile-screenshot-with-a-long-file-name.png", mimeType: "image/png", size: 483921, kind: "generated", chatId: "alpha", projectId: "p1", createdAt: now - 10_000, previewable: true },
  { artifactId: "a2", name: "customer-portal-release-notes-and-verification-report.pdf", mimeType: "application/pdf", size: 92341, kind: "upload", chatId: null, projectId: "p1", createdAt: now - 20_000, previewable: true },
];
const wallet = {
  plan: { id: "pro", label: "Pro", priceLabel: "$20 / month" },
  includedBalance: 120000, purchasedBalance: 30659, reservedBalance: 0, availableBalance: 150659,
  windows: {
    fiveHour: { used: 2100, limit: 10000, resetAt: now + 7_200_000 },
    sevenDay: { used: 18400, limit: 90000, resetAt: now + 345_600_000 },
    cycle: { used: 49341, limit: 200000, resetAt: now + 1_200_000_000 },
  },
  subscription: { status: "active", cycleStart: now - 1_000_000, cycleEnd: now + 1_200_000_000 },
};

function responseFor(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/v1/, "");
  if (p === "/auth/me") return { user: { id: "u1", email: "rm@example.com", name: "Raymond", emailVerified: true }, principal: { organizationId: "o1", organizationName: "Kernel AI Labs", organizationKind: "team", role: "owner", tenantId: "t1" }, organizations: [{ id: "o1", name: "Kernel AI Labs", kind: "team" }], onboarding: { step: "complete", completedAt: now }, legal: { version: "current", accepted: true, acceptance: { version: "current", source: "web", acceptedAt: now } } };
  if (p === "/billing") return { wallet, payments: { enabled: true, canManage: true, packs: [{ id: "small", credits: 50000, priceUsd: 10, available: true }] } };
  if (p === "/models") return { models: [{ id: "auto", name: "AUTO", description: "ORVYN chooses the best route.", kind: "orvyn", available: true }] };
  if (p === "/sessions" || p.startsWith("/sessions?")) return { sessions: [session] };
  if (p === "/sessions/alpha/messages") return { messages: [
    { messageId: "m1", role: "user", content: "Generate an image of a sunrise over snowy mountains, cinematic light.", createdAt: now - 30_000 },
    { messageId: "m2", role: "assistant", content: "I created the image and kept the composition suitable for a wide hero banner.", createdAt: now - 20_000 },
  ] };
  if (p === "/projects" || p.startsWith("/projects?")) return { projects: [project] };
  if (p === "/projects/p1") return { project };
  if (p === "/artifacts" || p.startsWith("/artifacts?")) return { artifacts };
  if (p === "/billing/stats") return { daily: [], byModel: [], byKind: [] };
  if (p === "/billing/account") return { invoices: [], paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 }, subscription: { cancelAtPeriodEnd: false, currentPeriodEnd: now + 1_200_000_000, status: "active" } };
  if (p === "/onboarding/plans") return { plans: [{ id: "pro", label: "Pro", priceMonthlyUsd: 20, priceAnnualUsd: 200, monthlyCredits: 200000, rolling5h: 10000, rolling7d: 90000, parallelAgents: 3, features: { premiumModels: "full", teamSeats: 3, priority: "high", apiAccess: true } }], packs: [] };
  if (p === "/auth/sessions") return { sessions: [] };
  if (p === "/account/connections") return { github: { connected: true, login: "kernel" }, deployment: { vercel: { connected: false }, netlify: { connected: false }, cloudflare: { connected: false } }, desktop: { connected: true, devices: [{ id: "d1", device: "Windows desktop", lastUsedAt: now }] } };
  if (p === "/account/notifications") return { notifications: [] };
  if (p === "/account/api-keys") return { included: true, keys: [] };
  if (p === "/account/team") return { organization: { name: "Kernel AI Labs" }, members: [], invites: [], canManage: true, role: "owner", plan: "Pro", seats: { used: 1, included: 3 } };
  return {};
}

const pages = [
  ["home", "/"], ["chats", "/chats/alpha"], ["project", "/projects/p1/chats/alpha"],
  ["files", "/files"], ["settings", "/settings"], ["billing", "/billing"], ["connections", "/settings/connections"],
];
const allViewports = [[320, 720], [360, 800], [375, 812], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
const requestedViewport = /^\d+x\d+$/.test(process.env.ORVYN_RESPONSIVE_VIEWPORT ?? "")
  ? process.env.ORVYN_RESPONSIVE_VIEWPORT.split("x").map(Number)
  : null;
const viewports = requestedViewport ? [requestedViewport] : allViewports;
let server;
if (ownServer) {
  server = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "--config", path.resolve("apps/web/vite.config.ts"), "--host", "127.0.0.1", "--port", "5199"], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* still starting */ }
    if (attempt === 59) throw new Error("The responsive test server did not start.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ORVYN_CHROME_PATH ? { executablePath: process.env.ORVYN_CHROME_PATH } : process.platform === "win32" ? { channel: "chrome" } : {}),
});
try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const [width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(() => {
      localStorage.setItem("orvyn.session", "responsive-test");
      localStorage.setItem("orvyn.filesView", "list");
    });
    const page = await context.newPage();
    await page.route("**/api/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responseFor(route.request().url())) }));
    for (const [name, route] of pages) {
      // The signed-in shell keeps background account requests alive. Waiting
      // for the rendered app is the stable readiness signal for this layout
      // acceptance; networkidle can hang even though the page is complete.
      await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
      await page.locator(".app").waitFor({ state: "visible" });
      const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(dimensions.page <= dimensions.viewport && dimensions.body <= dimensions.viewport, `${name} overflowed at ${width}x${height}: ${JSON.stringify(dimensions)}`);
      if (name === "files" && width <= 820) {
        const table = page.locator(".file-list");
        await table.waitFor({ state: "visible" });
        const overflow = await table.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(overflow.scroll > overflow.client, `files table should scroll inside its panel at ${width}x${height}: ${JSON.stringify(overflow)}`);
      }
      if (width <= 820) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page.locator(".side.is-open").waitFor({ state: "visible" });
        await page.locator(".side").getByRole("button", { name: "Close navigation" }).click();
        await page.waitForTimeout(250);
      }
      if (screenshotDir && [[390, 844], [768, 1024], [1440, 900]].some(([w, h]) => w === width && h === height)) {
        await page.screenshot({ path: path.join(screenshotDir, `${name}-${width}x${height}.png`), fullPage: false });
      }
    }
    await context.close();
  }
  console.log(`Responsive portal acceptance passed: ${pages.length} routes across ${viewports.length} viewports.`);
} finally {
  await browser.close();
  server?.kill();
}
