// apps/backend/src/execution/VercelBrowserRuntime.ts
//
// Source for the run-scoped browser helper installed inside a Vercel Sandbox.
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
const page = context.pages()[0] ?? await context.newPage();
const consoleErrors = [];
const networkErrors = [];
const actions = [];

page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text().slice(0, 1000));
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(String(error?.message ?? error).slice(0, 1000));
});
page.on("requestfailed", (request) => {
  const failure = request.failure()?.errorText ?? "failed";
  networkErrors.push(
    (request.method() + " " + request.url() + " " + failure).slice(0, 1200)
  );
});

function snapshot() {
  return {
    browserSessionId: "vercel-browser",
    url: page.url(),
    viewport: page.viewportSize(),
    consoleErrors: consoleErrors.slice(-50),
    networkErrors: networkErrors.slice(-50),
    actions: actions.slice(-100),
  };
}

async function run(message) {
  const op = String(message?.op ?? "");
  const a = message?.args ?? {};

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
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
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
      await page.goto(String(a.url), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    actions.push({ action: op, url: page.url(), timestamp: Date.now() });
    return {
      output: "Now at " + page.url() + " — title: " + (await page.title()),
      meta: snapshot(),
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
    const selector = String(a.selector ?? "");
    await page.click(selector, { timeout: 10000 });
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

  if (op === "type") {
    const selector = String(a.selector ?? "");
    await page.fill(selector, String(a.text ?? ""), { timeout: 10000 });
    if (a.submit === true) await page.press(selector, "Enter");
    actions.push({ action: op, selector, timestamp: Date.now() });
    return {
      output:
        "Typed into " +
        selector +
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

  if (op === "errors") {
    const all = [
      ...consoleErrors.map((value) => "[console] " + value),
      ...networkErrors.map((value) => "[network] " + value),
    ];
    return {
      output: all.length
        ? all.join("\\n")
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
