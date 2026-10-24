// apps/backend/src/desktop/cloudDesktop.ts
//
// Provider-neutral facade for ORVYN Cloud Desktop. Existing UI/routes/tools
// use this contract while Docker remains the legacy backend and Vercel becomes
// the managed cloud backend.

import type { TargetMatch } from "../agent/previewTarget";
import {
  captureSandboxFrame,
  captureSandboxScreenshot,
  findSandboxSession,
  listSandboxSessions,
  restartSandboxDesktop,
  sandboxAgentInput,
  sandboxInput,
  sandboxLaunchApp,
  sandboxNavigate,
  sandboxSendKeys,
  startSandboxDesktop,
  stopSandboxDesktop,
  subscribeFrames,
  type FrameQuality,
  type FrameSubscriber,
  type SandboxDesktopSession,
} from "./sandboxDesktop";
import {
  captureVercelDesktopFrame,
  captureVercelDesktopScreenshot,
  findVercelDesktopSession,
  listVercelDesktopSessions,
  restartVercelDesktop,
  startVercelDesktop,
  stopVercelDesktop,
  vercelDesktopInput,
  vercelDesktopLaunchApp,
  vercelDesktopNavigate,
  vercelDesktopSendKeys,
  type VercelDesktopSession,
} from "./vercelDesktop";

export type CloudDesktopSession =
  | SandboxDesktopSession
  | VercelDesktopSession;

export function isVercelDesktop(
  session: CloudDesktopSession
): session is VercelDesktopSession {
  return (session as VercelDesktopSession).provider === "vercel";
}

export function findCloudDesktopSession(
  tenantId: string,
  projectRoot?: string
): CloudDesktopSession | undefined {
  return (
    findVercelDesktopSession(tenantId, projectRoot) ??
    findSandboxSession(tenantId, projectRoot)
  );
}

export function listCloudDesktopSessions(
  tenantId: string
): CloudDesktopSession[] {
  return [
    ...listVercelDesktopSessions(tenantId),
    ...listSandboxSessions(tenantId),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

export async function startCloudDesktop(opts: {
  provider: "docker" | "vercel";
  tenantId: string;
  projectRoot: string;
  runId?: string;
  url?: string;
  width?: number;
  height?: number;
}): Promise<CloudDesktopSession> {
  if (opts.provider === "vercel") {
    if (!opts.runId) {
      throw new Error(
        "A Vercel Cloud Desktop must be attached to an active ORVYN Cloud run."
      );
    }
    return startVercelDesktop({
      tenantId: opts.tenantId,
      projectRoot: opts.projectRoot,
      runId: opts.runId,
      url: opts.url,
      width: opts.width,
      height: opts.height,
    });
  }
  return startSandboxDesktop({
    tenantId: opts.tenantId,
    projectRoot: opts.projectRoot,
    runId: opts.runId,
    url: opts.url,
    width: opts.width,
    height: opts.height,
  });
}

export function cloudDesktopTransport(
  session: CloudDesktopSession
): "sandbox-x11" | "vercel-x11" {
  return isVercelDesktop(session) ? "vercel-x11" : "sandbox-x11";
}

export async function captureCloudDesktopFrame(
  session: CloudDesktopSession,
  quality: FrameQuality = "auto"
): Promise<Buffer | null> {
  return isVercelDesktop(session)
    ? captureVercelDesktopFrame(session, quality)
    : captureSandboxFrame(session, quality);
}

export async function captureCloudDesktopScreenshot(
  session: CloudDesktopSession
): Promise<Buffer | null> {
  return isVercelDesktop(session)
    ? captureVercelDesktopScreenshot(session)
    : captureSandboxScreenshot(session);
}

export async function cloudDesktopInput(
  session: CloudDesktopSession,
  type: string,
  args: Record<string, unknown>,
  actor: "user" | "orion"
): Promise<boolean> {
  if (isVercelDesktop(session)) {
    return vercelDesktopInput(session, type, args, actor);
  }
  return actor === "orion"
    ? sandboxAgentInput(session, type, args)
    : sandboxInput(session, type, args);
}

export async function cloudDesktopSendKeys(
  session: CloudDesktopSession,
  combo: string
): Promise<boolean> {
  return isVercelDesktop(session)
    ? vercelDesktopSendKeys(session, combo)
    : sandboxSendKeys(session, combo);
}

export async function cloudDesktopLaunchApp(
  session: CloudDesktopSession,
  app: "terminal" | "files" | "chromium" | "editor" | "settings"
): Promise<boolean> {
  return isVercelDesktop(session)
    ? vercelDesktopLaunchApp(session, app)
    : sandboxLaunchApp(session, app);
}

export async function cloudDesktopNavigate(
  session: CloudDesktopSession,
  url: string
): Promise<{
  ok: boolean;
  error?: string;
  pageTitle?: string;
  target?: TargetMatch;
}> {
  return isVercelDesktop(session)
    ? vercelDesktopNavigate(session, url)
    : sandboxNavigate(session, url);
}

export async function stopCloudDesktop(
  session: CloudDesktopSession
): Promise<void> {
  if (isVercelDesktop(session)) {
    await stopVercelDesktop(session);
  } else {
    await stopSandboxDesktop(session);
  }
}

export async function restartCloudDesktop(
  session: CloudDesktopSession
): Promise<CloudDesktopSession> {
  return isVercelDesktop(session)
    ? restartVercelDesktop(session)
    : restartSandboxDesktop(session);
}

/**
 * Docker has an optimized ffmpeg/cached-frame stream. Vercel starts with a
 * conservative polling stream against the same X11 desktop; the renderer sees
 * the same SSE frame contract.
 */
export function subscribeCloudDesktopFrames(
  session: CloudDesktopSession,
  sub: FrameSubscriber
): (() => void) | null {
  if (!isVercelDesktop(session)) return subscribeFrames(session, sub);

  let closed = false;
  let busy = false;
  const tick = async () => {
    if (
      closed ||
      (session.status !== "ready" && session.status !== "user_control")
    ) {
      if (!closed) sub.end("stopped");
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const frame = await captureVercelDesktopFrame(session, "auto");
      if (frame && !closed) sub.frame(frame);
    } catch {
      // Next poll may recover; stream lifecycle remains truthful.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 250);
  void tick();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
