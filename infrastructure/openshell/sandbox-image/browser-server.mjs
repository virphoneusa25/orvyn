import { createHash } from "node:crypto";
import readline from "node:readline";
import { chromium } from "/usr/local/lib/node_modules/playwright-core/index.mjs";

const executablePath = "/ms-playwright/chromium-1187/chrome-linux/chrome";
const context = await chromium.launchPersistentContext("/tmp/orvyn-browser-profile", {
  executablePath,
  headless: true,
  viewport: { width: 1280, height: 800 },
  // OpenShell deliberately denies the credential-changing and namespace
  // syscalls Chromium's zygote uses. Keep every browser process inside the
  // already isolated sandbox instead of asking Chromium to fork a second
  // sandbox hierarchy of its own.
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
});
const page = context.pages()[0] ?? await context.newPage();
const consoleErrors = [];
const networkErrors = [];
const actions = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 1000)); });
page.on("pageerror", (e) => consoleErrors.push(String(e.message ?? e).slice(0, 1000)));
page.on("requestfailed", (r) => networkErrors.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? "failed"}`.slice(0, 1200)));

function snapshot() {
  return {
    browserSessionId: "sandbox-browser",
    url: page.url(),
    viewport: page.viewportSize(),
    consoleErrors: consoleErrors.slice(-50),
    networkErrors: networkErrors.slice(-50),
    actions: actions.slice(-100),
  };
}

async function run(message) {
  const op = String(message.op ?? "");
  const a = message.args ?? {};
  if (op === "input") {
    if(a.type==='click'){
      const size=page.viewportSize();
      if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x<0||a.y<0||a.x>=size.width||a.y>=size.height)throw new Error('Click outside viewport');
      await page.mouse.click(a.x,a.y);
    }else if(a.type==='type'){
      if(typeof a.text!=='string'||a.text.length>4000)throw new Error('Text too long');
      await page.keyboard.insertText(a.text);
    }else if(a.type==='key'){
      if(!['Enter','Tab','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(a.key))throw new Error('Unsupported key');
      await page.keyboard.press(a.key);
    }else if(a.type==='scroll'){
      if(!Number.isFinite(a.deltaY)||Math.abs(a.deltaY)>2000)throw new Error('Invalid scroll');
      await page.mouse.wheel(0,a.deltaY);
    }else throw new Error('Unsupported input');
    return {output:'User input applied.',meta:snapshot()};
  }
  if (op === "open" || op === "navigate") {
    consoleErrors.length = 0;
    networkErrors.length = 0;
    if (a.url) await page.goto(String(a.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    actions.push({ action: op, url: page.url(), timestamp: Date.now() });
    return { output: `Now at ${page.url()} — title: ${await page.title()}`, meta: snapshot() };
  }
  if (op === "viewport") {
    const presets = { desktop: [1280, 800], tablet: [820, 1180], mobile: [390, 844] };
    const [width, height] = presets[String(a.preset ?? "")] ?? [Number(a.width) || 1280, Number(a.height) || 800];
    await page.setViewportSize({ width, height });
    actions.push({ action: op, width, height, timestamp: Date.now() });
    return { output: `Viewport set to ${width}×${height}.`, meta: snapshot() };
  }
  if (op === "click") {
    await page.click(String(a.selector ?? ""), { timeout: 10_000 });
    actions.push({ action: op, selector: String(a.selector ?? ""), url: page.url(), timestamp: Date.now() });
    return { output: `Clicked ${a.selector}. URL now ${page.url()}`, meta: snapshot() };
  }
  if (op === "type") {
    const selector = String(a.selector ?? "");
    await page.fill(selector, String(a.text ?? ""), { timeout: 10_000 });
    if (a.submit === true) await page.press(selector, "Enter");
    actions.push({ action: op, selector, timestamp: Date.now() });
    return { output: `Typed into ${selector}${a.submit ? " and submitted" : ""}.`, meta: snapshot() };
  }
  if (op === "scroll") {
    const deltaY = Number(a.deltaY ?? 400);
    await page.mouse.wheel(0, deltaY);
    actions.push({ action: op, deltaY, timestamp: Date.now() });
    return { output: `Scrolled by ${deltaY}px.`, meta: snapshot() };
  }
  if (op === "screenshot") {
    const png = await page.screenshot({ fullPage: a.fullPage === true });
    const b64 = Buffer.from(png).toString("base64");
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    const screenshotId = `shot_${Date.now().toString(36)}`;
    actions.push({ action: op, screenshotId, timestamp: Date.now() });
    return {
      output: `Screenshot ${screenshotId} taken.`,
      meta: {
        ...snapshot(),
        screenshot: { b64, mediaType: "image/png" },
        browserScreenshot: { screenshotId, sessionId: "sandbox-browser", ...size, sha256: createHash("sha256").update(png).digest("hex") },
      },
    };
  }
  if (op === "errors") {
    const all = [...consoleErrors.map((x) => `[console] ${x}`), ...networkErrors.map((x) => `[network] ${x}`)];
    return { output: all.length ? all.join("\n") : "No console, page or network errors observed.", meta: snapshot() };
  }
  if (op === "evidence" || op === "state") return { output: JSON.stringify(snapshot()), meta: snapshot() };
  throw new Error(`Unknown browser operation: ${op}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  try {
    const result = await run(message);
    process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 2000) })}\n`);
  }
}
await context.close();
