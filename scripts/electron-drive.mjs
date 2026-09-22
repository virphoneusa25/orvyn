// scripts/electron-drive.mjs — helper for driving the REAL ORVYN Electron app
// over CDP (Playwright connectOverCDP). Usage from other scripts:
//   import { connect } from "./electron-drive.mjs";
const { chromium } = await import("playwright-core");

export async function connect(port = 9223) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().startsWith("file://")) ?? ctx.pages()[0];
  return { browser, page };
}

/** Visible text of the page body — the truth for UI-state assertions. */
export async function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}

/** Saves a PNG screenshot and returns the path. */
export async function shot(page, name) {
  const path = `C:/Users/rmckn/AppData/Local/Temp/orvyn-shots/${name}.png`;
  await page.screenshot({ path });
  return path;
}
