// apps/backend/src/execution/VercelBrowserRuntime.ts
//
// Source for the run-scoped browser helper installed inside a Vercel Sandbox.
// Provides agent-browser compatible accessibility snapshot, element-ref targeting (@e1, @e2),
// form filling, screenshotting, tab management, and SSRF security guards.
// Keep this as literal JavaScript source: do not use nested template
// interpolation inside the helper or the backend TypeScript compiler will try
// to resolve sandbox-local variables.

export const VERCEL_BROWSER_PORT = 9229;

export const VERCEL_BROWSER_SERVER_SOURCE = String.raw`
import http from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const context = await chromium.launchPersistentContext("/tmp/orvyn-browser-profile", {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

let activePageIndex = 0;
function getActivePage() {
  const pages = context.pages();
  if (activePageIndex >= pages.length) activePageIndex = Math.max(0, pages.length - 1);
  return pages[activePageIndex] ?? pages[0];
}

const consoleErrors = [];
const networkErrors = [];
const actions = [];
let cachedElements = [];

function setupPageListeners(p) {
  p.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 1000));
    }
  });
  p.on("pageerror", (error) => {
    consoleErrors.push(String(error?.message ?? error).slice(0, 1000));
  });
  p.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    networkErrors.push({
      method: request.method(),
      url: request.url(),
      status: 0,
      error: failure.slice(0, 500)
    });
  });
  p.on("response", (res) => {
    if (res.status() >= 400) {
      networkErrors.push({
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        error: "HTTP " + res.status() + " " + res.statusText()
      });
    }
  });
}

const initialPage = context.pages()[0] ?? await context.newPage();
setupPageListeners(initialPage);

function snapshot() {
  const p = getActivePage();
  return {
    browserSessionId: "vercel-browser",
    url: p ? p.url() : "",
    viewport: p ? p.viewportSize() : { width: 1280, height: 800 },
    consoleErrors: consoleErrors.slice(-50),
    networkErrors: networkErrors.slice(-50),
    actions: actions.slice(-100),
    interactiveElements: cachedElements.slice(0, 60),
  };
}

function checkSsrf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host === "169.254.169.254" ||
      host === "metadata.google.internal" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error("Access to private/local/metadata network target " + host + " is forbidden.");
    }
  } catch (err) {
    if (/forbidden/i.test(err.message)) throw err;
  }
}

async function run(message) {
  const op = String(message?.op ?? "");
  const a = message?.args ?? {};
  let page = getActivePage();

  if (op === "input") {
    if (a.type === "click") {
      const size = page.viewportSize();
      if (
        !size ||
        !Number.isFinite(a.x) ||
        !Number.isFinite(a.y) ||
        a.x < 0 ||
        a.y < 0 ||
        a.x >= size.width ||
        a.y >= size.height
      ) throw new Error("Click outside viewport");
      await page.mouse.click(a.x, a.y);
    } else if (a.type === "type") {
      if (typeof a.text !== "string" || a.text.length > 4000) {
        throw new Error("Text too long");
      }
      await page.keyboard.insertText(a.text);
    } else if (a.type === "key") {
      const allowed = [
        "Enter", "Tab", "Escape", "Backspace",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      ];
      if (!allowed.includes(a.key)) throw new Error("Unsupported key");
      await page.keyboard.press(a.key);
    } else if (a.type === "scroll") {
      if (!Number.isFinite(a.deltaY) || Math.abs(a.deltaY) > 2000) {
        throw new Error("Invalid scroll");
      }
      await page.mouse.wheel(0, a.deltaY);
    } else {
      throw new Error("Unsupported input");
    }
    return { output: "User input applied.", meta: snapshot() };
  }

  if (op === "open" || op === "navigate") {
    consoleErrors.length = 0;
    networkErrors.length = 0;
    if (a.url) {
      let targetUrl = String(a.url).trim();
      if (!/^https?:\/\//i.test(targetUrl) && !/^file:\/\//i.test(targetUrl)) {
        targetUrl = "https://" + targetUrl;
      }
      checkSsrf(targetUrl);
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    actions.push({ action: op, url: page.url(), timestamp: Date.now() });

    const pageInfo = await page.evaluate(() => {
      const title = document.title || "";
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content") || "";
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((h) => (h.tagName + ": " + (h.textContent || "").trim()))
        .filter((t) => t.length > 4)
        .slice(0, 15);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
        .filter((l) => l.text && l.href && !l.href.startsWith("#") && !l.href.startsWith("javascript:"))
        .slice(0, 20);
      const bodyText = (document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 3000);
      return { title, metaDesc, headings, links, bodyText };
    }).catch(() => null);

    const parts = [
      "Now at " + page.url() + " — Title: " + (pageInfo?.title || (await page.title())),
    ];
    if (pageInfo?.metaDesc) parts.push("Description: " + pageInfo.metaDesc);
    if (pageInfo?.headings?.length) {
      parts.push("Key Headings:\n" + pageInfo.headings.map((h) => "- " + h).join("\n"));
    }
    if (pageInfo?.links?.length) {
      parts.push("Navigation Links:\n" + pageInfo.links.map((l) => "- " + l.text + " (" + l.href + ")").join("\n"));
    }
    if (pageInfo?.bodyText) {
      parts.push("Rendered Page Content:\n" + pageInfo.bodyText);
    }

    return {
      output: parts.join("\n\n"),
      meta: {
        ...snapshot(),
        ...(pageInfo ? { pageInfo } : {}),
      },
    };
  }

  if (op === "snapshot") {
    const snap = await page.evaluate(() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };
      const interactive = Array.from(document.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [tabindex="0"]'
      )).filter(isVisible).slice(0, 60);

      const elements = interactive.map((el, i) => {
        const ref = "@e" + (i + 1);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : el.type || tag);
        const name = (el.innerText || el.getAttribute("aria-label") || el.placeholder || el.value || el.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const href = el.getAttribute("href") || undefined;
        el.setAttribute("data-orvyn-ref", ref);
        return { ref, role, name, href };
      });

      const lines = elements.map(e => "[" + e.ref + "] " + e.role + " \"" + e.name + "\"" + (e.href ? " -> " + e.href : ""));
      return { elements, treeText: lines.join("\n") };
    }).catch(() => ({ elements: [], treeText: "" }));

    cachedElements = snap.elements;
    actions.push({ action: op, count: snap.elements.length, timestamp: Date.now() });

    const output = [
      "Page: " + page.url() + " — Title: \"" + (await page.title().catch(() => "")) + "\"",
      "Interactive Elements (" + snap.elements.length + " found):",
      snap.treeText || "(No interactive elements detected on this page)",
      "Tip: Target elements using refs in browser_click or browser_fill (e.g. target: \"@e1\")."
    ].join("\n\n");

    return {
      output,
      meta: {
        ...snapshot(),
        interactiveCount: snap.elements.length,
        tree: snap.treeText,
      }
    };
  }

  if (op === "viewport") {
    const presets = {
      desktop: [1280, 800],
      tablet: [820, 1180],
      mobile: [390, 844],
    };
    const selected = presets[String(a.preset ?? "")];
    const width = selected ? selected[0] : Number(a.width) || 1280;
    const height = selected ? selected[1] : Number(a.height) || 800;
    await page.setViewportSize({ width, height });
    actions.push({ action: op, width, height, timestamp: Date.now() });
    return {
      output: "Viewport set to " + width + "×" + height + ".",
      meta: snapshot(),
    };
  }

  if (op === "click") {
    let selector = String(a.target ?? a.selector ?? "");
    if (/^@e\d+$/i.test(selector)) {
      selector = "[data-orvyn-ref=\"" + selector.toLowerCase() + "\"]";
    }
    if (a.x !== undefined && a.y !== undefined) {
      await page.mouse.click(Number(a.x), Number(a.y));
    } else {
      if (!selector) throw new Error("target, selector, or x/y coordinate is required for browser_click");
      await page.click(selector, { timeout: 10000 });
    }
    actions.push({
      action: op,
      selector,
      url: page.url(),
      timestamp: Date.now(),
    });
    return {
      output: "Clicked " + selector + ". URL now " + page.url(),
      meta: snapshot(),
    };
  }

  if (op === "fill" || op === "type") {
    let selector = String(a.target ?? a.selector ?? "");
    if (/^@e\d+$/i.test(selector)) {
      selector = "[data-orvyn-ref=\"" + selector.toLowerCase() + "\"]";
    }
    if (!selector) throw new Error("target or selector is required for browser_fill");
    const val = String(a.value ?? a.text ?? "");
    await page.fill(selector, val, { timeout: 10000 });
    if (a.submit === true) await page.press(selector, "Enter");
    actions.push({ action: op, selector, timestamp: Date.now() });
    return {
      output:
        "Filled " +
        selector +
        " with: \"" +
        (val.length > 50 ? val.slice(0, 50) + "..." : val) +
        "\"" +
        (a.submit ? " and submitted" : "") +
        ".",
      meta: snapshot(),
    };
  }

  if (op === "scroll") {
    const deltaY = Number(a.deltaY ?? 400);
    await page.mouse.wheel(0, deltaY);
    actions.push({ action: op, deltaY, timestamp: Date.now() });
    return {
      output: "Scrolled by " + deltaY + "px.",
      meta: snapshot(),
    };
  }

  if (op === "screenshot") {
    const png = await page.screenshot({ fullPage: a.fullPage === true });
    const b64 = Buffer.from(png).toString("base64");
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));
    const screenshotId = "shot_" + Date.now().toString(36);
    actions.push({ action: op, screenshotId, timestamp: Date.now() });
    return {
      output: "Screenshot " + screenshotId + " taken.",
      meta: {
        ...snapshot(),
        screenshot: { b64, mediaType: "image/png" },
        browserScreenshot: {
          screenshotId,
          sessionId: "vercel-browser",
          ...size,
          sha256: createHash("sha256").update(png).digest("hex"),
        },
      },
    };
  }

  if (op === "tabs") {
    const pages = context.pages();
    const tabList = await Promise.all(pages.map(async (p, idx) => ({
      index: idx,
      url: p.url(),
      title: await p.title().catch(() => ""),
      active: p === page,
    })));
    return {
      output: tabList.map(t => "Tab [" + t.index + "] " + (t.active ? "(active) " : "") + t.title + " — " + t.url).join("\n"),
      meta: { ...snapshot(), tabs: tabList }
    };
  }

  if (op === "switch_tab") {
    const idx = Number(a.index ?? 0);
    const pages = context.pages();
    if (idx < 0 || idx >= pages.length) throw new Error("Invalid tab index: " + idx);
    activePageIndex = idx;
    page = pages[idx];
    await page.bringToFront();
    actions.push({ action: op, index: idx, url: page.url(), timestamp: Date.now() });
    return { output: "Switched to tab " + idx + " (" + page.url() + ")", meta: snapshot() };
  }

  if (op === "errors" || op === "network_errors") {
    const lines = [];
    if (consoleErrors.length) {
      lines.push("Console Errors (" + consoleErrors.length + "):");
      consoleErrors.slice(-20).forEach(e => lines.push("  - [console] " + e));
    }
    if (networkErrors.length) {
      lines.push("Network Failures (" + networkErrors.length + "):");
      networkErrors.slice(-20).forEach(n => lines.push("  - [" + n.method + " " + n.status + "] " + n.url + " (" + n.error + ")"));
    }
    return {
      output: lines.length
        ? lines.join("\n")
        : "No console, page or network errors observed.",
      meta: snapshot(),
    };
  }

  if (op === "evidence" || op === "state") {
    return { output: JSON.stringify(snapshot()), meta: snapshot() };
  }

  throw new Error("Unknown browser operation: " + op);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...snapshot() }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
  }

  try {
    const message = JSON.parse(body || "{}");
    const result = await run(message);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: String(error?.message ?? error).slice(0, 2000),
      })
    );
  }
});

server.listen(9229, "127.0.0.1");

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    server.close();
    await context.close().catch(() => {});
    process.exit(0);
  });
}
`;
