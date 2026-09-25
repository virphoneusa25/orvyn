// Services (dev servers ORION started) as the status bar shows them.

export interface ServiceView {
  serviceId: string;
  name: string;
  command: string;
  status: "starting" | "running" | "unhealthy" | "stopped" | "failed";
  url?: string;
  port?: number;
  startedAt: number;
  stopReason?: string;
  location: "local" | "cloud";
}

const ACTIVE = new Set(["starting", "running", "unhealthy"]);

export function activeServices(list: ServiceView[]): ServiceView[] {
  return list.filter((s) => ACTIVE.has(s.status)).sort((a, b) => b.startedAt - a.startedAt);
}

export function servicesLabel(list: ServiceView[]): string | null {
  const active = activeServices(list);
  if (!active.length) return null;
  return `${active.length} service${active.length === 1 ? "" : "s"} running`;
}

export function uptime(startedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Only a service on this computer has a localhost the user's browser can open. */
export function openableUrl(s: ServiceView): string | undefined {
  return s.location === "local" && s.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(s.url) ? s.url : undefined;
}

export function statusText(s: ServiceView): string {
  if (s.status === "unhealthy") return "not answering";
  return s.status;
}
