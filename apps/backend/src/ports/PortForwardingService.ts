import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import http from "http";
import https from "https";
import type { IncomingMessage, ServerResponse } from "http";

export type PortClass = "web_preview" | "development_server" | "internal_service" | "unknown";
export type WorkbenchEnvironment = "local" | "sandbox" | "cloud";

export interface PortForwardRecord {
  id: string;
  tenantId: string;
  userId: string;
  runId?: string | null;
  workspace?: string | null;
  port: number;
  command?: string;
  environment: WorkbenchEnvironment;
  classification: PortClass;
  status: "listening" | "forwarded" | "inactive";
  tokenHash: string;
  previewPath?: string;
  targetHost: string;
  createdAt: number;
  expiresAt: number;
}

export interface PublicPortForward {
  id: string;
  port: number;
  command?: string;
  environment: WorkbenchEnvironment;
  classification: PortClass;
  status: "listening" | "forwarded" | "inactive";
  previewUrl?: string;
  localUrl?: string;
  createdAt: number;
}

const BLOCKED = new Set([
  5432, 5433, 6379, 6380, 6333, 6334, 27017, 3306, 9200, 11211, 5672, 15672,
  4570, 2019, 2375, 2376, 6443, 10250, 8500, 8600,
]);
const WEB = new Set([
  3000, 3001, 3002, 4000, 4173, 4200, 4300, 43181, 4321, 5000, 5173, 5174, 5175,
  8000, 8001, 8080, 8081, 8088, 8888, 1234, 24678,
]);
const DEV = /\b(vite|next|webpack|astro|nuxt|remix|angular|vue|react-scripts|storybook|parcel|esbuild|uvicorn|django|flask|rails)\b/i;
const INTERNAL = /\b(postgres|redis|qdrant|mongo|mysql|mariadb|elasticsearch|rabbitmq|orvyn-backend|caddy)\b/i;
const IDLE_MS = 30 * 60 * 1000;

export function classifyPort(port: number, command?: string): PortClass {
  if (BLOCKED.has(port) || INTERNAL.test(command ?? "")) return "internal_service";
  if (DEV.test(command ?? "")) return "development_server";
  if (WEB.has(port)) return "web_preview";
  return "unknown";
}

export function isAutoForwardCandidate(classification: PortClass, port: number): boolean {
  if (BLOCKED.has(port)) return false;
  return classification === "web_preview" || classification === "development_server";
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class PortForwardingService {
  private forwards = new Map<string, PortForwardRecord>();
  private tokens = new Map<string, string>();

  list(tenantId: string, runId?: string | null): PublicPortForward[] {
    this.expire(tenantId);
    return [...this.forwards.values()]
      .filter((f) => f.tenantId === tenantId && (!runId || f.runId === runId))
      .map((f) => this.toPublic(f));
  }

  detect(input: {
    tenantId: string;
    userId: string;
    runId?: string | null;
    workspace?: string | null;
    environment: WorkbenchEnvironment;
    ports: Array<{ port: number; command?: string }>;
    autoForward?: boolean;
    publicBase: string;
  }): PublicPortForward[] {
    const seen = new Set<number>();
    for (const raw of input.ports) {
      const port = Number(raw.port);
      if (!port || seen.has(port) || BLOCKED.has(port)) continue;
      seen.add(port);
      const classification = classifyPort(port, raw.command);
      const existing = [...this.forwards.values()].find(
        (f) => f.tenantId === input.tenantId && f.port === port && f.runId === (input.runId ?? null) && f.status !== "inactive"
      );
      if (existing) {
        existing.command = raw.command ?? existing.command;
        existing.classification = classification;
        existing.status = existing.status === "forwarded" ? "forwarded" : "listening";
        continue;
      }
      const rec = this.createRecord(input, port, raw.command, classification, "listening");
      this.forwards.set(rec.id, rec);
      if (input.autoForward && isAutoForwardCandidate(classification, port)) {
        this.markForwarded(rec, input.publicBase);
      }
    }
    this.markMissingInactive(input.tenantId, input.runId, seen);
    return this.list(input.tenantId, input.runId);
  }

  forward(input: {
    tenantId: string;
    userId: string;
    runId?: string | null;
    workspace?: string | null;
    environment: WorkbenchEnvironment;
    port: number;
    command?: string;
    publicBase: string;
  }): PublicPortForward {
    if (BLOCKED.has(input.port)) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    const classification = classifyPort(input.port, input.command);
    let rec = [...this.forwards.values()].find(
      (f) => f.tenantId === input.tenantId && f.port === input.port && f.runId === (input.runId ?? null) && f.status !== "inactive"
    );
    if (!rec) {
      rec = this.createRecord(input, input.port, input.command, classification, "listening");
      this.forwards.set(rec.id, rec);
    }
    this.markForwarded(rec, input.publicBase);
    return this.toPublic(rec, input.publicBase);
  }

  stop(tenantId: string, id: string): PublicPortForward {
    const rec = this.requireOwned(tenantId, id);
    rec.status = "listening";
    this.tokens.delete(rec.id);
    rec.tokenHash = "";
    rec.previewPath = undefined;
    return this.toPublic(rec);
  }

  authorize(tenantId: string, id: string, token: string): PortForwardRecord {
    const rec = this.requireOwned(tenantId, id);
    if (rec.status !== "forwarded" || !rec.tokenHash || !token) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    if (!tokensEqual(rec.tokenHash, hashToken(token))) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    if (Date.now() > rec.expiresAt) {
      rec.status = "inactive";
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    return rec;
  }

  authorizeByToken(id: string, token: string): PortForwardRecord {
    const rec = this.forwards.get(id);
    if (!rec) throw Object.assign(new Error("Not found"), { status: 404 });
    return this.authorize(rec.tenantId, id, token);
  }

  cleanup(tenantId: string, runId?: string | null): number {
    let n = 0;
    for (const [id, rec] of this.forwards) {
      if (rec.tenantId !== tenantId) continue;
      if (runId && rec.runId !== runId) continue;
      this.forwards.delete(id);
      this.tokens.delete(id);
      n += 1;
    }
    return n;
  }

  proxy(rec: PortForwardRecord, req: IncomingMessage, res: ServerResponse): void {
    const target = rec.environment === "local"
      ? { host: "127.0.0.1", port: rec.port }
      : { host: rec.targetHost || "127.0.0.1", port: rec.port };
    const lib = http;
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    delete (headers as any)["authorization"];
    const upstream = lib.request(
      {
        hostname: target.host,
        port: target.port,
        path: req.url?.replace(/^\/api\/v1\/ports\/[^/]+\/proxy/, "") || "/",
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.statusCode = 502;
      res.end("Preview unavailable");
    });
    if (req.readable && req.method !== "GET" && req.method !== "HEAD") req.pipe(upstream);
    else upstream.end();
    void https;
  }

  private createRecord(
    input: { tenantId: string; userId: string; runId?: string | null; workspace?: string | null; environment: WorkbenchEnvironment },
    port: number,
    command: string | undefined,
    classification: PortClass,
    status: PortForwardRecord["status"]
  ): PortForwardRecord {
    return {
      id: `port_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tenantId: input.tenantId,
      userId: input.userId,
      runId: input.runId ?? null,
      workspace: input.workspace ?? null,
      port,
      command,
      environment: input.environment,
      classification,
      status,
      tokenHash: "",
      targetHost: input.environment === "local" ? "127.0.0.1" : "127.0.0.1",
      createdAt: Date.now(),
      expiresAt: Date.now() + IDLE_MS,
    };
  }

  private markForwarded(rec: PortForwardRecord, publicBase: string): void {
    const token = `orvport_${randomBytes(18).toString("hex")}`;
    rec.tokenHash = hashToken(token);
    rec.status = "forwarded";
    rec.expiresAt = Date.now() + IDLE_MS;
    rec.previewPath = `/api/v1/ports/${rec.id}/proxy?fwd=${token}`;
    this.tokens.set(rec.id, token);
    void publicBase;
  }

  private markMissingInactive(tenantId: string, runId: string | null | undefined, listening: Set<number>): void {
    for (const rec of this.forwards.values()) {
      if (rec.tenantId !== tenantId) continue;
      if (runId && rec.runId !== runId) continue;
      if (!listening.has(rec.port) && rec.status !== "inactive") rec.status = "inactive";
    }
  }

  private expire(tenantId: string): void {
    const now = Date.now();
    for (const rec of this.forwards.values()) {
      if (rec.tenantId !== tenantId) continue;
      if (now > rec.expiresAt) rec.status = "inactive";
    }
  }

  private requireOwned(tenantId: string, id: string): PortForwardRecord {
    const rec = this.forwards.get(id);
    if (!rec || rec.tenantId !== tenantId) {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    return rec;
  }

  private toPublic(rec: PortForwardRecord, publicBase?: string): PublicPortForward {
    const localUrl = rec.environment === "local" ? `http://127.0.0.1:${rec.port}` : undefined;
    const previewUrl =
      rec.status === "forwarded" && rec.environment === "local"
        ? localUrl
        : rec.status === "forwarded" && rec.previewPath
          ? `${(publicBase ?? "").replace(/\/$/, "")}${rec.previewPath}`
          : undefined;
    return {
      id: rec.id,
      port: rec.port,
      command: rec.command,
      environment: rec.environment,
      classification: rec.classification,
      status: rec.status,
      previewUrl,
      localUrl,
      createdAt: rec.createdAt,
    };
  }
}

export const portForwardingService = new PortForwardingService();
