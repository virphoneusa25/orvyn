// apps/backend/src/routes/desktop.ts
//
// Desktop session routes. Two backends:
//   1. SANDBOX (Docker + Xvfb + openbox + Chromium) — the TRUE visual
//      desktop, available when Docker runs (OVH backend, CI).
//   2. PLAYWRIGHT viewport — Chromium page screenshots, the local-dev
//      fallback when Docker is unavailable (Windows desktop).
//
// Both share the same session model, control ownership, input mapping,
// and audit events. The DesktopView UI is backend-agnostic.

import { Router } from "express";
import { spawn } from "child_process";
import { requireTenant } from "../middleware/tenant";
import { playwrightAvailable, captureBrowserFrame, getBrowserSession, ensureBrowserSession } from "../ai/tools/browserTools";
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
import {
  startSandboxDesktop,
  captureSandboxFrame,
  sandboxInput,
  findSandboxSession,
  stopSandboxDesktop,
} from "../desktop/sandboxDesktop";
import { setElectronBrowserTarget } from "../desktop/electronBrowserTarget";

let dockerProbe: boolean | null = null;
async function hasDocker(): Promise<boolean> {
  if (dockerProbe !== null) return dockerProbe;
  dockerProbe = await new Promise<boolean>((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { windowsHide: true });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
  return dockerProbe;
}

function sandboxSessionFor(tenantId: string, projectRoot: string) {
  return findSandboxSession(tenantId, projectRoot || undefined);
}

export function desktopRouter(): Router {
  const router = Router();

  router.get("/session", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.query.projectRoot ?? t.currentProjectRoot ?? "");
    const docker = await hasDocker();

    // Sandbox session (true desktop) takes priority when available.
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox) {
      return res.json({
        session: {
          id: sandbox.id,
          status: sandbox.status,
          controlOwner: sandbox.controlOwner,
          width: sandbox.width,
          height: sandbox.height,
          url: sandbox.url,
          live: sandbox.status === "ready" || sandbox.status === "user_control",
          transport: "sandbox-x11",
          error: sandbox.error,
        },
        playwright: playwrightAvailable(),
        sandbox: docker,
      });
    }

    // Desktop sessions exist ONLY as sandbox containers — never browser pages.
    return res.json({ session: null, sandbox: docker });
  });

  router.post("/session", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    if (!projectRoot) return res.status(400).json({ error: "projectRoot required" });
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const url = typeof req.body?.url === "string" ? req.body.url : undefined;

    // PREFER the true sandbox desktop when Docker is available.
    const docker = await hasDocker();
    if (docker) {
      try {
        const sandbox = await startSandboxDesktop({
          tenantId: t.id,
          projectRoot,
          runId,
          url,
        });
        if (sandbox.status !== "error") {
          return res.json({
            session: {
              id: sandbox.id,
              status: sandbox.status,
              controlOwner: sandbox.controlOwner,
              width: sandbox.width,
              height: sandbox.height,
              url: sandbox.url,
              live: true,
              transport: "sandbox-x11",
            },
            sandbox: true,
          });
        }
        // Sandbox errored — fall through to Playwright with a note.
      } catch {
        // Sandbox unavailable (image not built?) — fall through to Playwright.
      }
    }

    // Desktop is a REAL sandbox (Xvfb + WM + Chromium in a container).
    // No Playwright fallback — a browser viewport is NOT a desktop.
    return res.status(503).json({
      error: "Desktop requires ORVYN Cloud (Docker sandbox runtime). Connect to ORVYN Cloud, or use the Browser tab for web pages.",
      sandbox: docker,
    });
  });

  router.get("/frame", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.query.projectRoot ?? t.currentProjectRoot ?? "");

    // Sandbox frame (X11 capture).
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox && sandbox.status !== "ended") {
      const jpeg = await captureSandboxFrame(sandbox);
      if (!jpeg) return res.status(409).json({ error: "Desktop has no live frame yet." });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Orvyn-Desktop-Control", sandbox.controlOwner);
      res.setHeader("X-Orvyn-Desktop-Transport", "sandbox-x11");
      if (sandbox.url) res.setHeader("X-Orvyn-Desktop-Url", encodeURIComponent(sandbox.url));
      return res.send(jpeg);
    }

    // Desktop frames come ONLY from the sandbox container.
    return res.status(404).json({ error: "No Desktop session. Desktop requires the Docker sandbox runtime." });
  });

  router.post("/control", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const owner = req.body?.owner === "user" ? "user" : req.body?.owner === "orion" ? "orion" : "";

    // Sandbox control.
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox && sandbox.status !== "ended") {
      if (owner !== "user" && owner !== "orion") return res.status(400).json({ error: "owner must be user or orion" });
      sandbox.controlOwner = owner;
      if (owner === "user") sandbox.status = "user_control";
      else sandbox.status = "ready";
      if (sandbox.runId && t.runStore.get(sandbox.runId)) {
        try {
          t.runStore.emit(sandbox.runId, "desktop.control.changed", {
            sessionId: sandbox.id,
            to: owner,
            controlOwner: sandbox.controlOwner,
            status: String(sandbox.status),
          });
        } catch { /* audit is best-effort */ }
      }
      return res.json({
        session: { id: sandbox.id, status: sandbox.status, controlOwner: sandbox.controlOwner, width: sandbox.width, height: sandbox.height, url: sandbox.url, live: true, transport: "sandbox-x11" },
      });
    }

    // Playwright control.
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const session = getDesktopSession(t.id, runId, projectRoot);
    if (!session || session.tenantId !== t.id) return res.status(404).json({ error: "No Desktop session." });
    if (owner !== "user" && owner !== "orion") return res.status(400).json({ error: "owner must be user or orion" });
    const result = requestControl(session, owner);
    if (!result.ok) return res.status(409).json({ error: result.reason, session: toPublic(session) });
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
      } catch { /* best-effort */ }
    }
    res.json({ session: toPublic(session) });
  });

  router.post("/input", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");

    // Sandbox input (xdotool).
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox && sandbox.status !== "ended") {
      if (sandbox.controlOwner !== "user") return res.status(409).json({ error: "Take Control before interacting with this desktop." });
      const ok = await sandboxInput(sandbox, String(req.body?.type ?? ""), req.body ?? {});
      return res.json({ ok, session: { id: sandbox.id, controlOwner: sandbox.controlOwner } });
    }

    // Playwright input.
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
          { x: Number(req.body.x ?? 0), y: Number(req.body.y ?? 0), width: Number(req.body.viewWidth ?? session.width), height: Number(req.body.viewHeight ?? session.height) },
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

  router.post("/stop", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");

    // Stop sandbox.
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox) {
      await stopSandboxDesktop(sandbox);
      return res.json({ session: { id: sandbox.id, status: "ended", controlOwner: "none" } });
    }

    // Stop Playwright.
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
