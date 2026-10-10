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
    { messageId: "m1", role: "user", content: "Review the website and update src/app.ts.", runId: "run-layout", createdAt: now - 30_000 },
    { messageId: "m2", role: "assistant", content: "Layout regression conversation.\n\n".repeat(60), runId: "run-layout", createdAt: now - 20_000 },
  ] };
  if (p === "/agent/stream/runs/run-layout/events.json") return { status: "completed", events: [
    { type: "run.execution", data: { executionTargetActual: "ovh_worker" } },
    { type: "tool.started", data: { tool: "browser_open" } },
    { type: "file.edit", data: { path: "src/app.ts", preview: { kind: "modify", additions: 1, deletions: 1, diff: [{ type: "remove", content: "old" }, { type: "add", content: "new" }] } } },
    { type: "terminal.started", data: { command: "npm test" } },
    { type: "terminal.output", data: { data: "All tests passed" } },
    { type: "terminal.completed", data: { exitOk: true } },
    { type: "run.completed", data: {} },
  ] };
  if (p === "/cloud-workbench/run-layout/files") return { ok: true, output: u.searchParams.has("path") ? u.searchParams.get("list") === "1" ? "app.ts\nassets/" : 'export const application = "ORVYN";\n' : "src/\nREADME.md" };
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

    await page.goto(`${origin}/chats/alpha`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Message", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".chat__stream")?.textContent?.includes("Layout regression conversation"));
    await page.getByLabel("Message", { exact: true }).fill("Draft preserved while inspecting workspace.");
    async function composerFits(label) {
      const rect = await page.locator(".composer").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= viewport.height + 1 && rect.x + rect.width <= viewport.width + 1, `${label}: composer outside viewport at ${width}x${height}: ${JSON.stringify(rect)}`);
      const scroll = await page.locator(".chat__stream").evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
      assert.ok(scroll.client > 30 && scroll.scroll > scroll.client, `${label}: chat must scroll independently: ${JSON.stringify(scroll)}`);
    }
    await composerFits("long conversation");
    if (width <= 820) {
      await page.setViewportSize({ width, height: Math.max(360, height - 300) });
      await page.waitForFunction(() => Math.abs(document.querySelector(".main").getBoundingClientRect().height - window.visualViewport.height) < 2);
      await composerFits("keyboard-sized viewport");
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => Math.abs(document.querySelector(".main").getBoundingClientRect().height - window.visualViewport.height) < 2);
      // Simulate iOS: visual viewport changes without a layout viewport resize.
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, "height", { value: window.innerHeight - 280, configurable: true });
        window.visualViewport.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() => Math.abs(document.querySelector(".main").getBoundingClientRect().height - window.visualViewport.height) < 2);
      const keyboardRect = await page.locator(".composer").boundingBox();
      const available = await page.evaluate(() => window.visualViewport.height);
      assert.ok(keyboardRect.y + keyboardRect.height <= available + 1, "iOS keyboard must leave composer visible");
      await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event("resize")); });
    }
    if (process.env.ORVYN_EXPECT_WORKBENCH === "1") {
      const pane = page.getByRole("complementary", { name: "Cloud workspace", exact: true });
      const toggle = page.getByRole("button", { name: /Open workspace|Back to chat/ });
      if (width <= 1050) assert.equal(await pane.isVisible(), false, "mobile workspace starts collapsed");
      if (!(await pane.isVisible())) await toggle.click();
      await pane.waitFor({ state: "visible" });
      if (width <= 1050) assert.equal(await page.locator(".chat").isVisible(), false, "workspace must replace, rather than stack below, mobile chat");
      await pane.getByRole("tab", { name: "Browser", exact: true }).click();
      await pane.getByText("This task has finished", { exact: true }).waitFor();
      assert.equal(await pane.getByRole("button", { name: "Take control" }).isEnabled(), false, "finished task cannot expose input controls");
      await pane.getByRole("tab", { name: /Changes/ }).click();
      await pane.getByText("1 file changed in this task", { exact: true }).waitFor();
      await pane.getByRole("tab", { name: "Terminal", exact: true }).click();
      await pane.locator(".cloud-workbench__terminal").waitFor();
      assert.match(await pane.locator(".cloud-workbench__terminal").innerText(), /npm test[\s\S]*All tests passed[\s\S]*Command finished/);
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await pane.getByRole("button", { name: "src/", exact: true }).click();
      await pane.getByRole("button", { name: "app.ts", exact: true }).click();
      await pane.locator(".cloud-workbench__code").waitFor();
      assert.match(await pane.locator(".cloud-workbench__code").innerText(), /export const application/);
      if (width > 1050) {
        await pane.getByRole("button", { name: "Expand workspace" }).click();
        assert.equal(await page.locator(".chat").isVisible(), false);
        await pane.getByRole("button", { name: "Restore split view" }).click();
        assert.equal(await page.locator(".chat").isVisible(), true);
      }
      const bounds = await pane.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, "workspace stays inside the viewport");
      if (screenshotDir && [390, 768, 1440].includes(width)) await page.screenshot({ path: path.join(screenshotDir, `workspace-${width}x${height}.png`) });
      await pane.getByRole("button", { name: "Close workspace" }).click();
      assert.equal(await pane.isVisible(), false);
      assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Draft preserved while inspecting workspace.");
      await composerFits("after closing workspace");
      await toggle.click();
      await pane.waitFor({ state: "visible" });
      await pane.getByRole("button", { name: "Close workspace" }).click();
      if (width <= 1050) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await toggle.click();
        await pane.waitFor({ state: "visible" });
        await page.setViewportSize({ width, height });
        await pane.waitFor({ state: "hidden" });
        await composerFits("after rotating to mobile");
      }
    }
    if (screenshotDir && [390, 768, 1440].includes(width)) await page.screenshot({ path: path.join(screenshotDir, `chat-fixed-${width}x${height}.png`) });

    await context.close();
  }

  if (process.env.ORVYN_EXPECT_WORKBENCH === "1") {
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addInitScript(() => {
        localStorage.setItem("orvyn.session", "responsive-test");
        window.__previewStarts = 0; window.__previewAborts = 0; window.__desktopAborts = 0;
        const original = window.fetch.bind(window);
        window.fetch = async (input, options) => {
          const url = typeof input === "string" ? input : input.url;
          let channel;
          if (/\/cloud-workbench\/run-layout\/browser\/stream/.test(url)) channel = "browser";
          if (/\/desktop\/stream\?runId=run-layout/.test(url)) channel = "desktop";
          if (/\/agent\/stream\/runs\/run-layout\/events\?/.test(url)) channel = "progress";
          if (!channel) return original(input, options);
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              if (channel === "browser") {
                window.__previewStream = controller; window.__previewStarts++;
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#10172a"/><text x="60" y="100" fill="#eceefa" font-size="30">ORVYN live browser fixture</text></svg>';
                controller.enqueue(encoder.encode('data: ' + JSON.stringify({ok:true,screenshot:{b64:btoa(svg),mediaType:"image/svg+xml"},control:{owner:"orion"}}) + '\n\n'));
              } else if (channel === "desktop") {
                window.__desktopStream = controller;
                const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 450;
                const ctx = canvas.getContext("2d"); ctx.fillStyle = "#10172a"; ctx.fillRect(0,0,800,450); ctx.fillStyle = "#eceefa"; ctx.font = "30px sans-serif"; ctx.fillText("ORVYN cloud desktop fixture",60,100);
                controller.enqueue(encoder.encode('event: frame\ndata: ' + canvas.toDataURL("image/jpeg").split(",")[1] + '\n\nevent: state\ndata: {"controlOwner":"orion"}\n\n'));
              } else { window.__progressStream = controller; controller.enqueue(encoder.encode(': heartbeat\n\n')); }
              options?.signal?.addEventListener("abort", () => {
                if (channel === "browser") window.__previewAborts++;
                if (channel === "desktop") window.__desktopAborts++;
                try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ }
              }, { once: true });
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        };
      });
      const page = await context.newPage();
      const inputs = [];
      let failInput = true;
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        let result = responseFor(url.href);
        if (url.pathname.endsWith("/run-layout/events.json")) result = { ...result, status: "running", events: [
          {type:"run.execution",data:{executionTargetActual:"ovh_worker"}},
          {type:"desktop.target",data:{surface:"desktop"}},
          {type:"tool.started",data:{tool:"browser_open"}},
        ] };
        if (url.pathname.endsWith("/desktop/session")) result = { session: { live: true, controlOwner: "orion", width: 800, height: 450 } };
        if (method === "POST" && url.pathname.endsWith("/control")) {
          const owner = route.request().postDataJSON().owner;
          result = url.pathname.includes("/browser/") ? { owner } : { session: { controlOwner: owner } };
        }
        if (method === "POST" && url.pathname.endsWith("/input")) {
          inputs.push({ path: url.pathname, ...route.request().postDataJSON() });
          result = failInput ? { ok: false, error: "Input blocked by fixture" } : { ok: true };
        }
        if (method === "POST" && url.pathname.endsWith("/stop")) {
          result = { ok: true };
          await page.evaluate(() => window.__progressStream.enqueue(new TextEncoder().encode('data: {"runId":"run-layout","sequence":100,"type":"run.cancelled","data":{}}\n\n')));
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
      });
      await page.goto(`${origin}/chats/alpha`, {waitUntil:"domcontentloaded"});
      const pane = page.getByRole("complementary", {name:"Cloud workspace",exact:true});
      await page.getByLabel("Message", {exact:true}).waitFor();
      if (!(await pane.isVisible())) await page.getByRole("button",{name:"Open workspace"}).click();
      await pane.waitFor();
      await pane.getByRole("tab",{name:"Browser",exact:true}).click();
      await page.waitForFunction(() => !document.querySelector(".cloud-workbench__preview-bar button").disabled);
      await pane.getByRole("button",{name:"Take control"}).click();
      await pane.getByText("You have control",{exact:true}).waitFor();
      await pane.locator(".cloud-workbench__screen").click();
      await pane.getByRole("alert").filter({hasText:"Input blocked by fixture"}).waitFor();
      failInput = false;
      const inputDone = page.waitForResponse(response => response.url().endsWith("/browser/input"));
      await pane.locator(".cloud-workbench__screen").click();
      await inputDone;
      assert.ok(inputs.length >= 2 && inputs[0].x >= 0 && inputs[0].x <= 800 && inputs[0].y >= 0 && inputs[0].y <= 450, "browser coordinates map to the real frame");
      if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,`workspace-live-browser-${width}.png`)});
      await pane.getByRole("button",{name:"Close workspace"}).click();
      await page.waitForFunction(() => window.__previewAborts > 0);
      await page.getByRole("button",{name:"Open workspace"}).click();
      await page.waitForFunction(() => window.__previewStarts > 1 && !document.querySelector(".cloud-workbench__preview-bar button").disabled);
      await page.evaluate(() => window.__previewStream.close());
      await pane.getByText("Session ended",{exact:true}).waitFor();
      assert.equal(await pane.getByRole("button",{name:"Take control"}).isEnabled(),false,"closed stream disables takeover");
      await pane.getByRole("button",{name:"Reconnect preview"}).click();
      await page.waitForFunction(() => window.__previewStarts > 2 && !document.querySelector(".cloud-workbench__preview-bar button").disabled);
      await pane.getByRole("tab",{name:"Desktop",exact:true}).click();
      await page.waitForFunction(() => !document.querySelector(".cloud-workbench__preview-bar button").disabled);
      await pane.getByRole("button",{name:"Take control"}).click();
      await pane.getByText("You have control",{exact:true}).waitFor();
      await pane.locator(".cloud-workbench__screen").click();
      await pane.getByRole("button",{name:"Return to ORVYN"}).click();
      if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,`workspace-live-desktop-${width}.png`)});
      await pane.getByRole("button",{name:"Stop task",exact:true}).click();
      await pane.getByText("Task finished",{exact:true}).waitFor();
      assert.equal(await pane.getByRole("button",{name:"Take control"}).isEnabled(),false,"cancelled task cannot accept input");
      await page.waitForFunction(() => window.__desktopAborts > 0);
      await context.close();
    }
    console.log("Live Cloud workspace acceptance passed: browser and desktop SSE, takeover, input failures, reconnect, collapse cleanup and stop on mobile and desktop widths.");
  }

  console.log(`Responsive portal acceptance passed: ${pages.length} routes across ${viewports.length} viewports.`);
} finally {
  await browser.close();
  server?.kill();
}
