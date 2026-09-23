// Port classification and forwarding policy. The live store lives on the
// control plane (PortForwardingService). This module is the shared contract.

import type { WorkbenchEnvironment } from "./workbenchEnvironment.ts";

export type PortClass = "web_preview" | "development_server" | "internal_service" | "unknown";

export interface DetectedPort {
  port: number;
  command?: string;
  environment: WorkbenchEnvironment;
  classification: PortClass;
  status: "listening" | "forwarded" | "inactive";
}

export interface PortForward {
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
  previewUrl?: string;
  localUrl?: string;
  createdAt: number;
}

export const BLOCKED_PORTS = new Set([
  5432, 5433, 6379, 6380, 6333, 6334, 27017, 3306, 9200, 11211, 5672, 15672,
  4570, 2019, 2375, 2376, 6443, 10250, 8500, 8600,
]);

export const WEB_PREVIEW_PORTS = new Set([
  3000, 3001, 3002, 4000, 4173, 4200, 4300, 43181, 4321, 5000, 5173, 5174, 5175,
  8000, 8001, 8080, 8081, 8088, 8888, 1234, 24678,
]);

const DEV_COMMAND = /\b(vite|next|webpack|astro|nuxt|remix|angular|vue|react-scripts|storybook|parcel|esbuild|uvicorn|django|flask|rails|php|hugo|eleventy)\b/i;
const INTERNAL_COMMAND = /\b(postgres|redis|qdrant|mongo|mysql|mariadb|elasticsearch|rabbitmq|memcached|orvyn-backend|caddy|etcd)\b/i;

export function classifyPort(port: number, command?: string): PortClass {
  if (BLOCKED_PORTS.has(port) || INTERNAL_COMMAND.test(command ?? "")) return "internal_service";
  if (DEV_COMMAND.test(command ?? "")) return "development_server";
  if (WEB_PREVIEW_PORTS.has(port)) return "web_preview";
  if (port >= 1024 && port < 49152) return "unknown";
  return "unknown";
}

export function isAutoForwardCandidate(classification: PortClass, port: number): boolean {
  if (BLOCKED_PORTS.has(port)) return false;
  return classification === "web_preview" || classification === "development_server";
}

export function isBlockedInfrastructurePort(port: number): boolean {
  return BLOCKED_PORTS.has(port);
}

export function localPreviewUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function detectPortsFromText(text: string, environment: WorkbenchEnvironment): DetectedPort[] {
  if (!text) return [];
  const found = new Map<number, DetectedPort>();
  const re = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const port = Number(m[1]);
    if (!port || port < 1 || port > 65535 || found.has(port)) continue;
    const classification = classifyPort(port, text);
    found.set(port, { port, command: commandHint(text), environment, classification, status: "listening" });
  }
  return [...found.values()];
}

function commandHint(text: string): string | undefined {
  const hit = text.match(DEV_COMMAND) ?? text.match(INTERNAL_COMMAND);
  return hit?.[1];
}

export function mergeDetectedPorts(current: DetectedPort[], next: DetectedPort[]): DetectedPort[] {
  const byPort = new Map<number, DetectedPort>();
  for (const p of current) byPort.set(p.port, p);
  for (const p of next) {
    const prev = byPort.get(p.port);
    byPort.set(p.port, prev ? { ...prev, ...p, status: p.status === "inactive" ? "inactive" : prev.status === "forwarded" ? "forwarded" : p.status } : p);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
