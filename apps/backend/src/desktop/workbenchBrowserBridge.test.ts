import { test } from "node:test";
import assert from "node:assert/strict";
import { noteWorkbenchBrowser, resetWorkbenchBrowserBridgeForTests, resolveWorkbenchBrowserCommand, takeWorkbenchBrowserCommands } from "./workbenchBrowserBridge";
import { makeBrowserOpenTool, makeBrowserScreenshotTool, makeBrowserViewportTool } from "../ai/tools/browserTools";
import { buildToolResultEnvelope } from "../gateway/toolResultEnvelope";

/** A stand-in for the desktop: one session, answers what the Local Worker would relay. */
function fakeDesktop(tenantId: string) {
  const seen: Record<string, unknown>[] = [];
  const session = { sessionId: "bs_abc123", runId: "", url: "", title: "", viewport: { preset: "desktop", width: 1280, height: 800, mobile: false }, consoleErrors: [], networkErrors: [], screenshots: [] as unknown[] };
  const timer = setInterval(() => {
    for (const { id, command } of takeWorkbenchBrowserCommands(tenantId)) {
      seen.push(command);
      session.runId = String(command.runId ?? "");
      if (command.op === "open") { session.url = "https://example.com/"; session.title = "Example Domain"; }
      if (command.op === "viewport") session.viewport = { preset: "mobile", width: 390, height: 844, mobile: true };
      const extra: Record<string, unknown> = {};
      if (command.op === "screenshot") {
        const shot = { screenshotId: "shot_1", sessionId: session.sessionId, url: session.url, width: 390, height: 700, sha256: "f".repeat(64) };
        session.screenshots.push(shot);
        Object.assign(extra, { screenshot: shot, png: "iVBORw0KGgo=" });
      }
      resolveWorkbenchBrowserCommand(tenantId, id, { ok: true, session: { ...session }, ...extra });
    }
  }, 5);
  return { seen, stop: () => clearInterval(timer) };
}

test("ORION's browser tools act on the Workbench session and report its id", async () => {
  resetWorkbenchBrowserBridgeForTests();
  noteWorkbenchBrowser("t1", true);
  const desk = fakeDesktop("t1");
  const ctx = { tenantId: "t1", runId: "run-9" };
  try {
    const open = await makeBrowserOpenTool("/tmp").execute({ url: "example.com" }, ctx);
    assert.equal(open.ok, true);
    assert.match(String(open.output), /browserSessionId: bs_abc123/);
    assert.equal(open.meta?.browserSessionId, "bs_abc123");
    const view = await makeBrowserViewportTool("/tmp").execute({ preset: "mobile" }, ctx);
    assert.match(String(view.output), /Viewport: Mobile 390×844/);
    const shot = await makeBrowserScreenshotTool("/tmp").execute({}, ctx);
    assert.equal((shot.meta?.browserScreenshot as { sessionId: string }).sessionId, "bs_abc123");
    assert.deepEqual(desk.seen.map((c) => [c.op, c.runId]), [["open", "run-9"], ["viewport", "run-9"], ["screenshot", "run-9"]]);

    const env = buildToolResultEnvelope({ toolName: "browser_screenshot", args: {}, result: shot });
    assert.deepEqual(env.evidence.map((e) => [e.type, e.value]), [["browser", "bs_abc123"], ["screenshot", "shot_1"]]);
    assert.equal(env.evidence[1]?.extra?.sessionId, "bs_abc123");
    assert.equal(JSON.stringify(env.structuredData).includes("iVBOR"), false, "no image bytes in structured data");
  } finally {
    desk.stop();
    resetWorkbenchBrowserBridgeForTests();
  }
});

test("a desktop that stops answering times out instead of hanging the run", async () => {
  resetWorkbenchBrowserBridgeForTests();
  noteWorkbenchBrowser("t2", true);
  const { sendWorkbenchBrowserCommand } = await import("./workbenchBrowserBridge");
  const r = await sendWorkbenchBrowserCommand("t2", { op: "state" }, 50);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /did not answer/);
});
