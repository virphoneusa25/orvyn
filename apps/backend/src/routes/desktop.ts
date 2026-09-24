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
import { randomUUID } from "crypto";
import { requireTenant } from "../middleware/tenant";
import { playwrightAvailable, getBrowserSession } from "../ai/tools/browserTools";
import {
  canUserAct,
  endDesktopSession,
  getDesktopSession,
  mapClientPoint,
  requestControl,
  toPublic,
} from "../desktop/desktopSession";
import {
  startSandboxDesktop,
  restartSandboxDesktop,
  captureSandboxFrame,
  captureSandboxScreenshot,
  sandboxInput,
  sandboxSendKeys,
  sandboxLaunchApp,
  findSandboxSession,
  stopSandboxDesktop,
  resolveKeyCombo,
  dockerAvailable,
  subscribeFrames,
  noteDesktopUse,
  type SandboxDesktopSession,
  type FrameQuality,
} from "../desktop/sandboxDesktop";
import { defaultDataDir } from "../persistence/LocalStore";
import { setElectronBrowserTarget } from "../desktop/electronBrowserTarget";

async function hasDocker(): Promise<boolean> {
  return dockerAvailable();
}

function sandboxSessionFor(tenantId: string, _projectRoot: string) {
  // Cross-path lookup: the client's local path (C:/...) NEVER matches the
  // server's resolved workspace path. Find by tenant only — the sandbox is
  // per-tenant, so this is correct and safe.
  return findSandboxSession(tenantId);
}

/** Public wire shape for a sandbox session — includes truthful resource
 *  metadata so the UI can display "Linux · 2 vCPU · 4 GB RAM". */
function publicSandbox(s: SandboxDesktopSession) {
  return {
    id: s.id,
    status: s.status,
    controlOwner: s.controlOwner,
    width: s.width,
    height: s.height,
    url: s.url,
    live: s.status === "ready" || s.status === "user_control",
    transport: "sandbox-x11",
    error: s.error,
    resources: s.resources,
    startedAt: s.startedAt ?? new Date(s.createdAt).toISOString(),
  };
}

function frameQuality(raw: unknown): FrameQuality {
  return raw === "low" || raw === "high" ? raw : "auto";
}

export function desktopRouter(): Router {
  const router = Router();

  // Desktop capability check — the UI uses this to distinguish
  // "signed out" (needs Cloud) from "connected but no worker" (specific error).
  router.get("/capabilities", async (req, res) => {
    const docker = await hasDocker();
    res.json({
      desktopAvailable: docker,
      transport: docker ? "sandbox-x11" : "none",
      reason: docker ? undefined : "Docker sandbox runtime not available on this backend.",
    });
  });

  router.get("/session", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.query.projectRoot ?? t.currentProjectRoot ?? "");
    const docker = await hasDocker();

    // Sandbox session (true desktop) takes priority when available.
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (sandbox) {
      return res.json({
        session: publicSandbox(sandbox),
        playwright: playwrightAvailable(),
        sandbox: docker,
      });
    }

    // Desktop sessions exist ONLY as sandbox containers — never browser pages.
    // Cross-path: the client path does not exist on the server - look by tenant.
    const anySandbox = findSandboxSession(t.id);
    if (anySandbox && anySandbox.status !== "ended") {
      return res.json({ session: publicSandbox(anySandbox), sandbox: docker });
    }
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
      // Cloud: the client sends its LOCAL path (C:/...) - resolve to a
      // server-side workspace path the sandbox can actually mount.
      const pathMod = await import("path");
      const fsMod = await import("fs");
      // basename() on Linux doesn't split Windows \ separators — split on
      // BOTH / and \ and take the last non-empty segment, so
      // "C:\Users\rmckn\myproject" yields "myproject", not the full path.
      const serverRoot = fsMod.existsSync(projectRoot)
        ? projectRoot
        : "/opt/orvyn/workspaces/" + (projectRoot.split(/[\\/]/).filter(Boolean).pop() || "default");
      try {
        const sandbox = await startSandboxDesktop({
          tenantId: t.id,
          projectRoot: serverRoot,
          runId,
          url,
        });
        if (sandbox.status !== "error") {
          return res.json({ session: publicSandbox(sandbox), sandbox: true });
        }
        // Sandbox errored — fall through to Playwright with a note.
      } catch (sandboxErr) {
        console.error("[desktop] sandbox creation failed:", sandboxErr);
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
      const jpeg = await captureSandboxFrame(sandbox, frameQuality(req.query.q));
      if (!jpeg) {
        return res.status(409).json({ error: "Desktop frame not yet available." });
      }
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

  // Live picture: Server-Sent Events, one "frame" event (base64 JPEG) per
  // changed picture. Viewers that fall behind skip to the newest picture
  // instead of queueing old ones. "unsupported" means this desktop image
  // cannot stream; the client keeps polling /frame.
  router.get("/stream", (req, res) => {
    const t = requireTenant(req);
    const sandbox = findSandboxSession(t.id);
    if (!sandbox || (sandbox.status !== "ready" && sandbox.status !== "user_control")) {
      return res.status(404).json({ error: "No live Desktop session." });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ id: sandbox.id, width: sandbox.width, height: sandbox.height })}\n\n`);

    let closed = false;
    let waiting: Buffer | null = null;
    const write = (jpeg: Buffer) => {
      if (closed) return;
      if (res.writableNeedDrain) { waiting = jpeg; return; }
      res.write(`event: frame\ndata: ${jpeg.toString("base64")}\n\n`);
    };
    const onDrain = () => { const next = waiting; waiting = null; if (next) write(next); };
    res.on("drain", onDrain);

    const heartbeat = setInterval(() => {
      if (closed) return;
      noteDesktopUse(sandbox.id);
      res.write(`event: state\ndata: ${JSON.stringify({ controlOwner: sandbox.controlOwner, status: sandbox.status })}\n\n`);
    }, 5000);
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.off("drain", onDrain);
      unsubscribe?.();
    };
    const unsubscribe = subscribeFrames(sandbox, {
      frame: write,
      end: (reason) => {
        if (closed) return;
        res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
        finish();
        res.end();
      },
    });
    if (!unsubscribe) {
      res.write(`event: end\ndata: ${JSON.stringify({ reason: "unsupported" })}\n\n`);
      closed = true;
      clearInterval(heartbeat);
      return res.end();
    }
    // res "close" fires when the viewer disconnects (req "close" fires as
    // soon as the GET request itself has been read).
    res.on("close", finish);
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
          if (owner === "orion") {
            t.runStore.emit(sandbox.runId, "desktop.returned", { sessionId: sandbox.id, refreshScreenshot: true });
          }
        } catch { /* audit is best-effort */ }
      }
      return res.json({ session: publicSandbox(sandbox) });
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
          if (owner === "orion") {
            t.runStore.emit(session.runId, "desktop.returned", { sessionId: session.id, refreshScreenshot: true });
          }
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

  // ── Screenshot → artifact/evidence ─────────────────────────────────────
  router.post("/screenshot", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (!sandbox || sandbox.status === "ended") {
      return res.status(404).json({ error: "No Desktop session." });
    }
    const png = await captureSandboxScreenshot(sandbox);
    if (!png) return res.status(409).json({ error: "Desktop frame not yet available." });

    const fs = await import("fs");
    const path = await import("path");
    const dir = path.join(defaultDataDir(), "desktop-shots", t.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = `desktop-${sandbox.id}-${Date.now()}.png`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, png);

    const artifact = {
      id: `shot_${randomUUID().slice(0, 12)}`,
      projectRoot: projectRoot || null,
      runId: sandbox.runId ?? null,
      kind: "screenshot",
      name,
      path: file,
      mediaType: "image/png",
    };
    try { t.localStore.saveArtifact(artifact); } catch { /* persistence best-effort */ }
    if (sandbox.runId && t.runStore.get(sandbox.runId)) {
      try {
        t.runStore.emit(sandbox.runId, "desktop.screenshot", { name, path: file, sessionId: sandbox.id });
      } catch { /* audit best-effort */ }
    }
    res.json({ ok: true, artifact });
  });

  // ── Send Keys (named combos; host clipboard is NEVER synced) ───────────
  router.post("/keys", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (!sandbox || sandbox.status === "ended") {
      return res.status(404).json({ error: "No Desktop session." });
    }
    const combo = String(req.body?.combo ?? "");
    if (!resolveKeyCombo(combo)) {
      return res.status(400).json({ error: `Unknown key combo: ${combo}` });
    }
    const ok = await sandboxSendKeys(sandbox, combo);
    res.json({ ok });
  });

  // ── Restart the desktop container ──────────────────────────────────────
  router.post("/restart", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (!sandbox) return res.status(404).json({ error: "No Desktop session." });
    try {
      const fresh = await restartSandboxDesktop(sandbox);
      res.json({ session: publicSandbox(fresh) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Launch a dock app inside the live desktop ──────────────────────────
  router.post("/launch", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body?.projectRoot ?? t.currentProjectRoot ?? "");
    const sandbox = sandboxSessionFor(t.id, projectRoot);
    if (!sandbox || sandbox.status === "ended") {
      return res.status(404).json({ error: "No Desktop session." });
    }
    const app = String(req.body?.app ?? "");
    if (!["terminal", "files", "chromium", "editor", "settings"].includes(app)) {
      return res.status(400).json({ error: `Unknown app: ${app}` });
    }
    const ok = await sandboxLaunchApp(sandbox, app as "terminal" | "files" | "chromium" | "editor" | "settings");
    res.json({ ok });
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
