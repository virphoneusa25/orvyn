import { Router } from "express";
import { requireTenant } from "../middleware/tenant";
import { playwrightAvailable } from "../ai/tools/browserTools";
import { captureBrowserFrame } from "../ai/tools/browserTools";
import {
  canUserAct,
  createDesktopSession,
  endDesktopSession,
  getDesktopSession,
  listDesktopSessions,
  mapClientPoint,
  requestControl,
  toPublic,
} from "../desktop/desktopSession";
import { getBrowserSession, ensureBrowserSession } from "../ai/tools/browserTools";
import { setElectronBrowserTarget } from "../desktop/electronBrowserTarget";

export function desktopRouter(): Router {
  const router = Router();

  router.get("/session", (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.query.projectRoot ?? t.currentProjectRoot ?? "");
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    const session = getDesktopSession(t.id, runId, projectRoot) ?? listDesktopSessions(t.id)[0];
    if (!session) return res.json({ session: null, playwright: playwrightAvailable() });
    if (session.tenantId !== t.id) return res.status(403).json({ error: "Desktop session is not in this workspace." });
    res.json({ session: toPublic(session), playwright: playwrightAvailable() });
  });

  router.post("/session", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    if (!projectRoot) return res.status(400).json({ error: "projectRoot required" });
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    if (!playwrightAvailable()) {
      return res.status(503).json({ error: "Desktop runtime unavailable. Install Playwright Chromium on the worker." });
    }
    const session = createDesktopSession({ tenantId: t.id, projectRoot, runId });
    try {
      const browser = await ensureBrowserSession(projectRoot);
      session.status = "agent_control";
      session.controlOwner = "orion";
      session.url = String(browser.page.url() || req.body?.url || "");
      res.json({ session: toPublic(session) });
    } catch (err: any) {
      session.status = "error";
      session.error = err.message;
      res.status(500).json({ error: err.message, session: toPublic(session) });
    }
  });

  router.get("/frame", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.query.projectRoot ?? t.currentProjectRoot ?? "");
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    const session = getDesktopSession(t.id, runId, projectRoot);
    if (!session || session.tenantId !== t.id) return res.status(404).json({ error: "No Desktop session." });
    const frame = await captureBrowserFrame(projectRoot);
    if (!frame) return res.status(409).json({ error: "Desktop has no live frame yet." });
    session.lastFrameAt = Date.now();
    session.url = frame.url;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Orvyn-Desktop-Url", encodeURIComponent(frame.url));
    res.setHeader("X-Orvyn-Desktop-Control", session.controlOwner);
    res.send(frame.jpeg);
  });

  router.post("/control", (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const owner = req.body?.owner === "user" ? "user" : req.body?.owner === "orion" ? "orion" : "";
    const session = getDesktopSession(t.id, runId, projectRoot);
    if (!session || session.tenantId !== t.id) return res.status(404).json({ error: "No Desktop session." });
    if (owner !== "user" && owner !== "orion") return res.status(400).json({ error: "owner must be user or orion" });
    const result = requestControl(session, owner);
    if (!result.ok) return res.status(409).json({ error: result.reason, session: toPublic(session) });
    // Control transitions are part of the run's auditable history — the same
    // event stream the Desktop UI replays. Emitted only for the session's
    // own run; never a fabricated id.
    if (session.runId) {
      try {
        if (t.runStore.get(session.runId)) {
          t.runStore.emit(session.runId, "desktop.control.changed", {
            sessionId: session.id,
            to: owner,
            controlOwner: session.controlOwner,
            status: session.status,
          });
        }
      } catch { /* audit is best-effort; the control change already succeeded */ }
    }
    res.json({ session: toPublic(session) });
  });

  router.post("/input", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const session = getDesktopSession(t.id, runId, projectRoot);
    if (!session || session.tenantId !== t.id) return res.status(404).json({ error: "No Desktop session." });
    if (!canUserAct(session)) return res.status(409).json({ error: "Take Control before interacting with this desktop." });
    const page = getBrowserSession(projectRoot)?.page;
    if (!page) return res.status(409).json({ error: "Desktop browser is not running." });
    const kind = String(req.body?.type ?? "");
    try {
      if (kind === "move" || kind === "click" || kind === "dblclick" || kind === "rightclick" || kind === "scroll") {
        const mapped = mapClientPoint(
          {
            x: Number(req.body.x ?? 0),
            y: Number(req.body.y ?? 0),
            width: Number(req.body.viewWidth ?? session.width),
            height: Number(req.body.viewHeight ?? session.height),
          },
          session
        );
        await page.mouse.move(mapped.x, mapped.y);
        if (kind === "click") await page.mouse.click(mapped.x, mapped.y);
        if (kind === "dblclick") await page.mouse.dblclick(mapped.x, mapped.y);
        if (kind === "rightclick") await page.mouse.click(mapped.x, mapped.y, { button: "right" });
        if (kind === "scroll") await page.mouse.wheel(0, Number(req.body.deltaY ?? 120));
      } else if (kind === "key") {
        await page.keyboard.press(String(req.body.key ?? "Enter"));
      } else if (kind === "type") {
        await page.keyboard.type(String(req.body.text ?? ""));
      } else {
        return res.status(400).json({ error: "Unknown input type." });
      }
      session.lastActionAt = Date.now();
      res.json({ ok: true, session: toPublic(session) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/stop", (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const session = getDesktopSession(t.id, runId, projectRoot);
    if (!session || session.tenantId !== t.id) return res.status(404).json({ error: "No Desktop session." });
    endDesktopSession(session);
    res.json({ session: toPublic(session) });
  });

  router.post("/browser-target", (req, res) => {
    const t = requireTenant(req);
    try {
      const target = setElectronBrowserTarget(t.id, String(req.body?.url ?? ""), String(req.body?.token ?? ""));
      res.json({ ok: true, url: target.url });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
