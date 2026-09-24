import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

export type ServiceStatus = "starting" | "healthy" | "unhealthy" | "stopping" | "stopped" | "failed";

export interface ServiceRecord {
  serviceId: string;
  runId: string;
  tenantId: string;
  command: string;
  cwd: string;
  pid?: number;
  ports: number[];
  status: ServiceStatus;
  startedAt: number;
  lastHealthAt?: number;
}

const SERVICE = /\b(npm run dev|npm start|vite|next dev|next start|python3? -m http\.server|node\s+\S*server\.(?:js|mjs|cjs))\b/i;

export function isServiceCommand(command: string): boolean {
  return SERVICE.test(command);
}

/** Long-running processes. Finishing a run does not stop them. */
export class ServiceManager {
  private services = new Map<string, ServiceRecord>();
  private children = new Map<string, ChildProcess>();

  list(runId?: string): ServiceRecord[] {
    return [...this.services.values()].filter((s) => !runId || s.runId === runId);
  }

  start(input: { runId: string; tenantId: string; command: string; cwd: string; port?: number }): ServiceRecord {
    const serviceId = randomUUID();
    const record: ServiceRecord = {
      serviceId,
      runId: input.runId,
      tenantId: input.tenantId,
      command: input.command,
      cwd: input.cwd,
      ports: input.port ? [input.port] : [],
      status: "starting",
      startedAt: Date.now(),
    };
    const child = spawn(input.command, { cwd: input.cwd, shell: true, detached: true, stdio: "ignore" });
    child.unref();
    record.pid = child.pid;
    child.on("exit", (code) => {
      const current = this.services.get(serviceId);
      if (!current || current.status === "stopping" || current.status === "stopped") return;
      current.status = "failed";
      current.lastHealthAt = Date.now();
      void code;
    });
    this.children.set(serviceId, child);
    this.services.set(serviceId, record);
    record.status = "healthy";
    record.lastHealthAt = Date.now();
    return record;
  }

  /** Run completion must not tear these down. */
  releaseRun(runId: string): ServiceRecord[] {
    return this.list(runId);
  }

  stop(serviceId: string): ServiceRecord | undefined {
    const record = this.services.get(serviceId);
    if (!record) return undefined;
    record.status = "stopping";
    const child = this.children.get(serviceId);
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    }
    record.status = "stopped";
    this.children.delete(serviceId);
    return record;
  }
}
