import {
  beginAgentAction,
  canAgentAct,
  createDesktopSession,
  endAgentAction,
  endDesktopSession,
  findDesktopSession,
  getDesktopSession,
  requestControl,
  toPublic,
  type DesktopSession,
} from "../desktop/desktopSession";
import {
  captureSandboxFrame,
  captureSandboxScreenshot,
  findSandboxSession,
  sandboxAgentInput,
  sandboxLaunchApp,
  startSandboxDesktop,
  type SandboxDesktopSession,
} from "../desktop/sandboxDesktop";
import {
  beginHostAgentAction,
  getHostDesktopState,
  isHostDesktopAllowed,
  returnHostControl,
  takeHostControl,
} from "../desktop/hostDesktopSession";
import { hostClick, hostKey, hostMove, hostScroll, hostType } from "../desktop/hostDesktopActions";
import type { ComputerUseIdentity } from "./types";

/** Tenant-scoped desktop control. Models never talk to this directly. */
export class DesktopSessionService {
  ensureSession(identity: ComputerUseIdentity): DesktopSession {
    const existing = this.getSession(identity);
    if (existing) return existing;
    return createDesktopSession({
      tenantId: identity.tenantId,
      projectRoot: identity.projectRoot,
      runId: identity.runId ?? undefined,
      organizationId: identity.organizationId ?? undefined,
      userId: identity.userId ?? undefined,
    });
  }

  getSession(identity: ComputerUseIdentity): DesktopSession | undefined {
    if (identity.desktopSessionId) {
      const byId = findDesktopSession(identity.desktopSessionId, identity.tenantId);
      if (byId) return byId;
    }
    return getDesktopSession(identity.tenantId, identity.runId ?? undefined, identity.projectRoot);
  }

  sandbox(identity: ComputerUseIdentity): SandboxDesktopSession | undefined {
    return findSandboxSession(identity.tenantId, identity.projectRoot);
  }

  async captureScreenshot(identity: ComputerUseIdentity): Promise<{ bytes: Buffer; mediaType: string; sessionId: string } | null> {
    const sb = this.sandbox(identity);
    if (sb) {
      const png = await captureSandboxScreenshot(sb);
      if (png) return { bytes: png, mediaType: "image/png", sessionId: sb.id };
      const frame = await captureSandboxFrame(sb, "high");
      if (frame) return { bytes: frame, mediaType: "image/jpeg", sessionId: sb.id };
    }
    const session = this.getSession(identity);
    return session ? { bytes: Buffer.alloc(0), mediaType: "image/jpeg", sessionId: session.id } : null;
  }

  async sendInput(
    identity: ComputerUseIdentity,
    kind: "click" | "type" | "scroll" | "key" | "move",
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const sb = this.sandbox(identity);
    if (sb) {
      if (sb.controlOwner === "user") {
        return { ok: false, error: "User has taken control. ORION input is paused.", sessionId: sb.id };
      }
      const ok = await sandboxAgentInput(sb, kind, args);
      return ok
        ? { ok: true, sessionId: sb.id }
        : { ok: false, error: "Desktop did not accept input.", sessionId: sb.id };
    }
    const session = this.ensureSession(identity);
    if (!canAgentAct(session)) {
      return { ok: false, error: "User has taken control. ORION input is paused.", sessionId: session.id };
    }
    const lock = beginAgentAction(session);
    if (!lock.ok) return { ok: false, error: lock.reason, sessionId: session.id };
    endAgentAction(session);
    return { ok: true, sessionId: session.id };
  }

  getWindows(identity: ComputerUseIdentity): { id: string; status: string; controlOwner: string }[] {
    const sb = this.sandbox(identity);
    if (sb) return [{ id: sb.id, status: sb.status, controlOwner: sb.controlOwner }];
    const session = this.getSession(identity);
    return session ? [{ id: session.id, status: session.status, controlOwner: session.controlOwner }] : [];
  }

  handoffControl(identity: ComputerUseIdentity, owner: "user" | "orion"): { ok: boolean; error?: string; returned?: boolean } {
    const sb = this.sandbox(identity);
    if (sb) {
      sb.controlOwner = owner;
      sb.status = owner === "user" ? "user_control" : "ready";
      return { ok: true, returned: owner === "orion" };
    }
    if (isHostDesktopAllowed(identity.tenantId) && !this.getSession(identity)) {
      owner === "user" ? takeHostControl(identity.tenantId) : returnHostControl(identity.tenantId);
      return { ok: true, returned: owner === "orion" };
    }
    const session = this.getSession(identity);
    if (!session) return { ok: false, error: "No Desktop session." };
    const result = requestControl(session, owner);
    return { ok: result.ok, error: result.reason, returned: result.ok && owner === "orion" };
  }

  async openApp(identity: ComputerUseIdentity, app: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    let sb = this.sandbox(identity);
    if (!sb) {
      try {
        sb = await startSandboxDesktop({
          tenantId: identity.tenantId,
          projectRoot: identity.projectRoot,
          runId: identity.runId ?? undefined,
        });
      } catch {
        return { ok: false, error: "Desktop session could not start." };
      }
    }
    const name = desktopAppName(app);
    if (!name) return { ok: false, sessionId: sb.id, error: `Unknown app "${app}". Use browser, terminal, files, editor or settings.` };
    const ok = await sandboxLaunchApp(sb, name);
    return { ok, sessionId: sb.id, error: ok ? undefined : `Could not open ${app}` };
  }

  cleanup(identity: ComputerUseIdentity): void {
    const session = this.getSession(identity);
    if (session) endDesktopSession(session);
  }

  publicView(identity: ComputerUseIdentity) {
    const session = this.getSession(identity);
    return session ? toPublic(session) : null;
  }

  hostAllowed(tenantId: string): boolean {
    return isHostDesktopAllowed(tenantId);
  }

  beginHostAction(tenantId: string, action: string) {
    return beginHostAgentAction(tenantId, action);
  }

  async sendHostInput(
    tenantId: string,
    kind: "click" | "type" | "scroll" | "key" | "move",
    args: { x?: number; y?: number; text?: string; key?: string; deltaY?: number }
  ): Promise<{ ok: boolean; error?: string; output?: string }> {
    if (kind === "click") return hostClick(tenantId, Number(args.x ?? 0), Number(args.y ?? 0));
    if (kind === "move") return hostMove(tenantId, Number(args.x ?? 0), Number(args.y ?? 0));
    if (kind === "type") return hostType(tenantId, String(args.text ?? ""));
    if (kind === "scroll") return hostScroll(tenantId, Number(args.deltaY ?? -120));
    return hostKey(tenantId, String(args.key ?? "Enter"));
  }

  hostState(tenantId: string) {
    return getHostDesktopState(tenantId);
  }
}

export const desktopSessionService = new DesktopSessionService();

/** Desktop dock apps by the names people and models actually use. */
export function desktopAppName(app: string): "terminal" | "files" | "chromium" | "editor" | "settings" | null {
  const key = String(app ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const map: Record<string, "terminal" | "files" | "chromium" | "editor" | "settings"> = {
    terminal: "terminal", shell: "terminal", console: "terminal", lxterminal: "terminal",
    files: "files", file: "files", filemanager: "files", fileexplorer: "files", explorer: "files", thunar: "files", folder: "files",
    browser: "chromium", chromium: "chromium", chrome: "chromium", firefox: "chromium", web: "chromium",
    editor: "editor", code: "editor", vscode: "editor", texteditor: "editor", geany: "editor",
    settings: "settings", appearance: "settings",
  };
  return map[key] ?? null;
}
