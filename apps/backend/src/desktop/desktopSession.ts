// Isolated visual desktop session. One session per tenant+run.
// Control ownership is exclusive: ORION and the user never act at once.

export type DesktopStatus =
  | "starting"
  | "ready"
  | "agent_control"
  | "user_control"
  | "paused"
  | "ended"
  | "error";

export type ControlOwner = "orion" | "user" | "none";

export interface DesktopSession {
  id: string;
  runId?: string;
  tenantId: string;
  organizationId?: string;
  userId?: string;
  workerId?: string;
  projectRoot: string;
  status: DesktopStatus;
  controlOwner: ControlOwner;
  width: number;
  height: number;
  url?: string;
  startedAt: string;
  lastFrameAt?: number;
  lastActionAt?: number;
  inputInFlight: boolean;
  queuedAgentActions: number;
  error?: string;
  transport: "playwright-frames" | "unavailable";
}

export interface DesktopPublic {
  id: string;
  runId?: string;
  tenantId: string;
  status: DesktopStatus;
  controlOwner: ControlOwner;
  width: number;
  height: number;
  url?: string;
  startedAt: string;
  live: boolean;
  transport: DesktopSession["transport"];
  error?: string;
}

const sessions = new Map<string, DesktopSession>();

export function sessionKey(tenantId: string, runId?: string, projectRoot?: string): string {
  // Tools are registered per project, not per run. Key on tenant+project so
  // ToolGateway and the Workbench UI always find the same session.
  return `${tenantId}::${projectRoot || runId || "default"}`;
}

export function createDesktopSession(input: {
  tenantId: string;
  projectRoot: string;
  runId?: string;
  organizationId?: string;
  userId?: string;
  workerId?: string;
  width?: number;
  height?: number;
  transport?: DesktopSession["transport"];
}): DesktopSession {
  const key = sessionKey(input.tenantId, input.runId, input.projectRoot);
  const existing = sessions.get(key);
  if (existing && existing.status !== "ended" && existing.status !== "error") {
    return existing;
  }
  const now = new Date().toISOString();
  const session: DesktopSession = {
    id: `desk_${Math.random().toString(36).slice(2, 10)}`,
    runId: input.runId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    userId: input.userId,
    workerId: input.workerId,
    projectRoot: input.projectRoot,
    status: "starting",
    controlOwner: "none",
    width: input.width ?? 1280,
    height: input.height ?? 800,
    startedAt: now,
    inputInFlight: false,
    queuedAgentActions: 0,
    transport: input.transport ?? "playwright-frames",
  };
  sessions.set(key, session);
  return session;
}

export function markDesktopReady(session: DesktopSession, url?: string): DesktopSession {
  if (session.status === "ended" || session.status === "error") return session;
  session.status = "agent_control";
  session.controlOwner = "orion";
  if (url) session.url = url;
  return session;
}

export function markDesktopError(session: DesktopSession, error: string): DesktopSession {
  session.status = "error";
  session.controlOwner = "none";
  session.error = error;
  return session;
}

export function endDesktopSession(session: DesktopSession): DesktopSession {
  session.status = "ended";
  session.controlOwner = "none";
  session.inputInFlight = false;
  return session;
}

export function getDesktopSession(tenantId: string, runId?: string, projectRoot?: string): DesktopSession | undefined {
  const exact = sessions.get(sessionKey(tenantId, runId, projectRoot));
  if (exact) return exact;
  if (projectRoot) {
    const byRoot = sessions.get(sessionKey(tenantId, undefined, projectRoot));
    if (byRoot) return byRoot;
  }
  return [...sessions.values()].find((s) => s.tenantId === tenantId && s.status !== "ended" && s.status !== "error");
}

export function findDesktopSession(id: string, tenantId: string): DesktopSession | undefined {
  for (const s of sessions.values()) {
    if (s.id === id && s.tenantId === tenantId) return s;
  }
  return undefined;
}

export function listDesktopSessions(tenantId: string): DesktopSession[] {
  return [...sessions.values()].filter((s) => s.tenantId === tenantId && s.status !== "ended");
}

export function toPublic(session: DesktopSession): DesktopPublic {
  return {
    id: session.id,
    runId: session.runId,
    tenantId: session.tenantId,
    status: session.status,
    controlOwner: session.controlOwner,
    width: session.width,
    height: session.height,
    url: session.url,
    startedAt: session.startedAt,
    live: session.status === "agent_control" || session.status === "user_control" || session.status === "ready",
    transport: session.transport,
    error: session.error,
  };
}

export function canAgentAct(session: DesktopSession): boolean {
  if (session.status === "ended" || session.status === "error" || session.status === "paused") return false;
  return session.controlOwner === "orion" && !session.inputInFlight;
}

export function canUserAct(session: DesktopSession): boolean {
  if (session.status === "ended" || session.status === "error") return false;
  return session.controlOwner === "user";
}

export function beginAgentAction(session: DesktopSession): { ok: true } | { ok: false; queued: true; reason: string } {
  if (session.controlOwner === "user") {
    session.queuedAgentActions += 1;
    return { ok: false, queued: true, reason: "User controls this desktop. Agent actions are paused." };
  }
  if (session.inputInFlight) {
    session.queuedAgentActions += 1;
    return { ok: false, queued: true, reason: "An input action is in flight." };
  }
  if (!canAgentAct(session)) {
    return { ok: false, queued: true, reason: `Desktop is ${session.status}.` };
  }
  session.inputInFlight = true;
  session.lastActionAt = Date.now();
  return { ok: true };
}

export function endAgentAction(session: DesktopSession): DesktopSession {
  session.inputInFlight = false;
  return session;
}

export function requestControl(
  session: DesktopSession,
  next: ControlOwner
): { ok: boolean; session: DesktopSession; reason?: string } {
  if (session.status === "ended" || session.status === "error") {
    return { ok: false, session, reason: "Session is not active." };
  }
  if (session.inputInFlight) {
    return { ok: false, session, reason: "Wait for the current input action to finish." };
  }
  if (next === "user") {
    session.controlOwner = "user";
    session.status = "user_control";
    return { ok: true, session };
  }
  if (next === "orion") {
    session.controlOwner = "orion";
    session.status = "agent_control";
    session.queuedAgentActions = 0;
    return { ok: true, session };
  }
  session.controlOwner = "none";
  session.status = "paused";
  return { ok: true, session };
}

export function mapClientPoint(
  client: { x: number; y: number; width: number; height: number },
  session: Pick<DesktopSession, "width" | "height">
): { x: number; y: number } {
  const sx = client.width > 0 ? session.width / client.width : 1;
  const sy = client.height > 0 ? session.height / client.height : 1;
  return {
    x: Math.max(0, Math.min(session.width - 1, Math.round(client.x * sx))),
    y: Math.max(0, Math.min(session.height - 1, Math.round(client.y * sy))),
  };
}

export function desktopIdleTimeoutMs(): number {
  const n = Number(process.env.ORVYN_DESKTOP_IDLE_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

export function sweepIdleDesktopSessions(now = Date.now()): number {
  const timeout = desktopIdleTimeoutMs();
  let closed = 0;
  for (const [key, s] of sessions) {
    if (s.status === "ended" || s.status === "error") continue;
    const last = s.lastActionAt ?? Date.parse(s.startedAt);
    const busy = s.status === "agent_control" && s.inputInFlight;
    if (!busy && now - last > timeout) {
      endDesktopSession(s);
      sessions.delete(key);
      closed += 1;
    }
  }
  return closed;
}

export function resetDesktopSessionsForTests(): void {
  sessions.clear();
}
