// apps/backend/src/desktop/workbenchBrowserBridge.ts
//
// How ORION's browser tools reach the Workbench Browser the user is looking
// at, wherever the control plane runs. The desktop Local Worker picks up
// browser commands on its poll, hands them to the desktop app's
// BrowserSessionManager over IPC, and posts the answer back here.
//
// There is no second browser on this path: every command acts on the one
// session in the user's Workbench.

export interface BrowserBridgeCommand {
  op: string;
  runId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

interface Pending {
  id: string;
  tenantId: string;
  command: BrowserBridgeCommand;
  createdAt: number;
  taken: boolean;
  resolve: (result: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const capable = new Map<string, number>();
const ONLINE_MS = 45_000;
let seq = 0;

/** The Local Worker says (on register, heartbeat, poll) whether it can reach the Workbench Browser. */
export function noteWorkbenchBrowser(tenantId: string, available: boolean): void {
  if (available) capable.set(tenantId, Date.now());
  else capable.delete(tenantId);
}

export function workbenchBrowserOnline(tenantId: string): boolean {
  const seen = capable.get(tenantId);
  return seen !== undefined && Date.now() - seen < ONLINE_MS;
}

/** Sends one command and waits for the desktop's answer. */
export function sendWorkbenchBrowserCommand(tenantId: string, command: BrowserBridgeCommand, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = `bc_${Date.now().toString(36)}_${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `The Workbench Browser did not answer within ${Math.round(timeoutMs / 1000)}s.`, timedOut: true });
    }, timeoutMs);
    pending.set(id, { id, tenantId, command, createdAt: Date.now(), taken: false, resolve, timer });
  });
}

/** Commands for this tenant's worker that it has not picked up yet. */
export function takeWorkbenchBrowserCommands(tenantId: string): { id: string; command: BrowserBridgeCommand }[] {
  const out: { id: string; command: BrowserBridgeCommand }[] = [];
  for (const p of pending.values()) {
    if (p.tenantId !== tenantId || p.taken) continue;
    p.taken = true;
    out.push({ id: p.id, command: p.command });
  }
  return out;
}

export function resolveWorkbenchBrowserCommand(tenantId: string, id: string, result: unknown): boolean {
  const p = pending.get(id);
  if (!p || p.tenantId !== tenantId) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(result && typeof result === "object" ? (result as Record<string, unknown>) : { ok: false, error: "Empty answer from the Workbench Browser." });
  return true;
}

export function resetWorkbenchBrowserBridgeForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  capable.clear();
}
