// apps/desktop/src/renderer/connection.ts
// Central place every panel gets the backend URL + API key from, so
// pointing the whole app at a cloud-deployed backend is one settings
// change instead of editing every component.
//
// Cloud host lives here once. Components call apiUrl()/wsUrl() — they do
// not hardcode https://orvyn.virphoneusa.com.

export const LOCAL_BACKEND_URL = "http://localhost:4570";

function cloudUrlFromEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.ORVYN_CLOUD_URL?.trim();
  return value || undefined;
}

/** Production OVH control plane. Staging overrides this with a saved backend URL. */
export const ORVYN_CLOUD_URL = cloudUrlFromEnv() || "https://orvyn.virphoneusa.com";

export interface ConnectionConfig {
  backendUrl: string; // e.g. https://orvyn.virphoneusa.com or http://localhost:4570
  apiKey: string;
}

let current: ConnectionConfig = { backendUrl: LOCAL_BACKEND_URL, apiKey: "" };
const listeners = new Set<(c: ConnectionConfig) => void>();

export async function loadConnectionConfig(): Promise<ConnectionConfig> {
  current = await window.orvyn.config.get();
  listeners.forEach((l) => l(current));
  return current;
}

export async function saveConnectionConfig(config: ConnectionConfig): Promise<void> {
  const backendUrl = secureBackendUrl(config.backendUrl);
  current = await window.orvyn.config.set({ ...config, backendUrl });
  listeners.forEach((l) => l(current));
}

export function getConnectionConfig(): ConnectionConfig {
  return current;
}

export function onConnectionChange(listener: (c: ConnectionConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isCloudBackend(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]";
  } catch {
    return false;
  }
}

export type ConnectionMode = "local" | "cloud";

export function connectionMode(url: string): ConnectionMode {
  return isCloudBackend(url) ? "cloud" : "local";
}

/**
 * Cloud credentials travel only over HTTPS. Localhost may stay on HTTP.
 * An http cloud URL is upgraded; anything that is not http(s) is rejected.
 */
export function secureBackendUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Backend URL is not valid");
  }
  if (!isCloudBackend(trimmed)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Local Mode requires http or https");
    }
    return trimmed;
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") throw new Error("Cloud Mode requires https");
  return parsed.toString().replace(/\/$/, "");
}

/** http(s) base → ws(s) URL. https always becomes wss. */
export function toWebSocketUrl(backendUrl: string, path: string, token?: string): string {
  const base = secureBackendUrl(backendUrl);
  const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${wsBase}${path}${query}`;
}

export function isSessionToken(key: string | undefined | null): boolean {
  return !!key && key.startsWith("orvsess_");
}

export function apiUrl(path: string): string {
  return `${current.backendUrl.replace(/\/$/, "")}/api/v1${path}`;
}

export function healthUrl(): string {
  return `${current.backendUrl.replace(/\/$/, "")}/api/v1/health`;
}

export function wsUrl(path: string): string {
  return toWebSocketUrl(current.backendUrl, path, current.apiKey || undefined);
}

export function authHeaders(): Record<string, string> {
  return current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {};
}

/** Host and scheme only. Never includes a token, password, or API key. */
export function describeTransport(backendUrl: string): {
  mode: ConnectionMode;
  backendHost: string;
  wsHost: string;
  wsScheme: "ws" | "wss";
} {
  const base = secureBackendUrl(backendUrl);
  const url = new URL(base);
  const wsScheme = url.protocol === "https:" ? "wss" : "ws";
  return { mode: connectionMode(base), backendHost: url.host, wsHost: url.host, wsScheme };
}

let protectedStatusHandler: ((status: number, url: string) => void) | null = null;
let authFailureLatched = false;

export function onProtectedStatus(handler: ((status: number, url: string) => void) | null): void {
  protectedStatusHandler = handler;
}

export function resetAuthFailureLatch(): void {
  authFailureLatched = false;
}

/** 401/403 on a protected call with a session token expires the account once. Login failures are ignored. */
export function noteProtectedStatus(status: number, url: string): void {
  if (status !== 401 && status !== 403) return;
  if (/\/auth\/(login|register)(?:\?|$)/.test(url)) return;
  if (!isSessionToken(current.apiKey)) return;
  if (authFailureLatched) return;
  authFailureLatched = true;
  protectedStatusHandler?.(status, url);
}


export type OrchestratorConnectionState = "connecting" | "online" | "offline";
const statusListeners = new Set<(s: OrchestratorConnectionState) => void>();
let orchestratorStatus: OrchestratorConnectionState = "offline";
let heartbeatSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let orchestratorHook: ((s: OrchestratorConnectionState) => void) | null = null;

function publishStatus(s: OrchestratorConnectionState) {
  if (orchestratorStatus === s) return;
  orchestratorStatus = s;
  statusListeners.forEach((l) => l(s));
  orchestratorHook?.(s);
}
export function getOrchestratorStatus() { return orchestratorStatus; }
export function onOrchestratorStatus(listener: (s: OrchestratorConnectionState) => void) {
  statusListeners.add(listener); listener(orchestratorStatus);
  return () => statusListeners.delete(listener);
}
export function setOrchestratorStatusHook(hook: ((s: OrchestratorConnectionState) => void) | null): void {
  orchestratorHook = hook;
}

let heartbeatGen = 0;

function startHeartbeat(): void {
  const gen = ++heartbeatGen;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const previous = heartbeatSocket;
  heartbeatSocket = null;
  previous?.close();

  const connect = () => {
    if (gen !== heartbeatGen) return;
    publishStatus("connecting");
    const ws = new WebSocket(wsUrl("/ws/chat"));
    heartbeatSocket = ws;
    let ready = false;
    const readyTimer = setTimeout(() => {
      if (!ready && gen === heartbeatGen) ws.close();
    }, 8000);
    ws.onmessage = (ev) => {
      if (gen !== heartbeatGen) return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "connection.ready") {
          ready = true;
          clearTimeout(readyTimer);
          publishStatus("online");
        }
        if (msg.error && /unauthorized/i.test(String(msg.error)) && isSessionToken(current.apiKey)) {
          noteProtectedStatus(401, wsUrl("/ws/chat"));
        }
      } catch {
        /* ignore non-json frames */
      }
    };
    ws.onerror = () => {
      if (gen === heartbeatGen) publishStatus("offline");
    };
    ws.onclose = () => {
      clearTimeout(readyTimer);
      if (gen !== heartbeatGen) return;
      if (heartbeatSocket === ws) heartbeatSocket = null;
      publishStatus("offline");
      if (!authFailureLatched) reconnectTimer = setTimeout(connect, 3000);
    };
  };
  connect();
}

export function connectOrchestratorHeartbeat(): () => void {
  startHeartbeat();
  const gen = heartbeatGen;
  return () => {
    if (heartbeatGen !== gen) return;
    heartbeatGen++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    heartbeatSocket?.close();
    heartbeatSocket = null;
    publishStatus("offline");
  };
}

/** One socket for the whole app. Restart after the backend URL or token changes. */
export function ensureOrchestratorHeartbeat(): void {
  startHeartbeat();
}

/** Stop reconnecting. Used when the session is expired so a bad token is not retried forever. */
export function stopOrchestratorHeartbeat(): void {
  heartbeatGen++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  heartbeatSocket?.close();
  heartbeatSocket = null;
  publishStatus("offline");
}
