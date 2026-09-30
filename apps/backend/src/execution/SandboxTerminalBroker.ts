import { randomUUID } from "crypto";

export type TerminalAction = { id: string; sessionId: string; runId: string; type: "open" | "input" | "resize" | "close"; data?: string; cols?: number; rows?: number };
export type TerminalEvent = { sequence: number; type: "output" | "exit" | "error"; data?: string; exitCode?: number; at: number };
export type TerminalSession = { id: string; runId: string; tenantId: string; createdAt: number; updatedAt: number; events: TerminalEvent[]; nextSequence: number; closed: boolean };

/** Short-lived relay. The shell and all bytes stay on the assigned worker. */
export class SandboxTerminalBroker {
  private sessions = new Map<string, TerminalSession>();
  private actions = new Map<string, TerminalAction[]>();

  open(runId: string, tenantId: string, cols = 120, rows = 32): TerminalSession {
    const id = `term_${randomUUID()}`;
    const session: TerminalSession = { id, runId, tenantId, createdAt: Date.now(), updatedAt: Date.now(), events: [], nextSequence: 1, closed: false };
    this.sessions.set(id, session);
    this.enqueue({ id: randomUUID(), sessionId: id, runId, type: "open", cols, rows });
    return session;
  }
  get(id: string, tenantId: string): TerminalSession | null { const s = this.sessions.get(id); return s?.tenantId === tenantId ? s : null; }
  input(id: string, tenantId: string, data: string): boolean { const s = this.get(id, tenantId); if (!s || s.closed) return false; this.enqueue({ id: randomUUID(), sessionId: id, runId: s.runId, type: "input", data: data.slice(0, 64_000) }); return true; }
  resize(id: string, tenantId: string, cols: number, rows: number): boolean { const s = this.get(id, tenantId); if (!s || s.closed) return false; this.enqueue({ id: randomUUID(), sessionId: id, runId: s.runId, type: "resize", cols: Math.max(20, Math.min(400, cols)), rows: Math.max(5, Math.min(200, rows)) }); return true; }
  close(id: string, tenantId: string): boolean { const s = this.get(id, tenantId); if (!s || s.closed) return false; s.closed = true; this.enqueue({ id: randomUUID(), sessionId: id, runId: s.runId, type: "close" }); return true; }
  poll(runId: string): TerminalAction | null { const q = this.actions.get(runId); return q?.shift() ?? null; }
  push(id: string, event: Omit<TerminalEvent, "sequence" | "at">): boolean { const s = this.sessions.get(id); if (!s) return false; s.updatedAt = Date.now(); s.events.push({ ...event, sequence: s.nextSequence++, at: Date.now() }); if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000); if (event.type === "exit" || event.type === "error") s.closed = true; return true; }
  read(id: string, tenantId: string, after = 0): { events: TerminalEvent[]; closed: boolean } | null { const s = this.get(id, tenantId); return s ? { events: s.events.filter((e) => e.sequence > after), closed: s.closed } : null; }
  closeRun(runId: string): void { for (const s of this.sessions.values()) if (s.runId === runId && !s.closed) this.close(s.id, s.tenantId); }
  private enqueue(action: TerminalAction): void { const q = this.actions.get(action.runId) ?? []; q.push(action); this.actions.set(action.runId, q); }
}

export const sandboxTerminalBroker = new SandboxTerminalBroker();
