// apps/desktop/src/renderer/connection.ts
// Central place every panel gets the backend URL + API key from, so
// pointing the whole app at a cloud-deployed backend is one settings
// change instead of editing every component.

export interface ConnectionConfig {
  backendUrl: string; // e.g. https://orvyn.yourdomain.com or http://localhost:4570
  apiKey: string;
}

let current: ConnectionConfig = { backendUrl: "http://localhost:4570", apiKey: "" };
const listeners = new Set<(c: ConnectionConfig) => void>();

export async function loadConnectionConfig(): Promise<ConnectionConfig> {
  current = await window.orvyn.config.get();
  listeners.forEach((l) => l(current));
  return current;
}

export async function saveConnectionConfig(config: ConnectionConfig): Promise<void> {
  current = await window.orvyn.config.set(config);
  listeners.forEach((l) => l(current));
}

export function getConnectionConfig(): ConnectionConfig {
  return current;
}

export function onConnectionChange(listener: (c: ConnectionConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function apiUrl(path: string): string {
  return `${current.backendUrl.replace(/\/$/, "")}/api/v1${path}`;
}

export function wsUrl(path: string): string {
  const wsBase = current.backendUrl.replace(/^http/, "ws").replace(/\/$/, "");
  const token = current.apiKey ? `?token=${encodeURIComponent(current.apiKey)}` : "";
  return `${wsBase}${path}${token}`;
}

export function authHeaders(): Record<string, string> {
  return current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {};
}


export type OrchestratorConnectionState = "connecting" | "online" | "offline";
const statusListeners = new Set<(s: OrchestratorConnectionState) => void>();
let orchestratorStatus: OrchestratorConnectionState = "offline";
let heartbeatSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function publishStatus(s: OrchestratorConnectionState) {
  if (orchestratorStatus === s) return;
  orchestratorStatus = s;
  statusListeners.forEach((l) => l(s));
}
export function getOrchestratorStatus() { return orchestratorStatus; }
export function onOrchestratorStatus(listener: (s: OrchestratorConnectionState) => void) {
  statusListeners.add(listener); listener(orchestratorStatus);
  return () => statusListeners.delete(listener);
}
export function connectOrchestratorHeartbeat(): () => void {
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    publishStatus("connecting");
    heartbeatSocket?.close();
    const ws = new WebSocket(wsUrl("/ws/chat"));
    heartbeatSocket = ws;
    let ready = false;
    const readyTimer = setTimeout(() => { if (!ready) ws.close(); }, 8000);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "connection.ready") { ready = true; clearTimeout(readyTimer); publishStatus("online"); }
      } catch {}
    };
    ws.onerror = () => publishStatus("offline");
    ws.onclose = () => {
      clearTimeout(readyTimer);
      if (heartbeatSocket === ws) heartbeatSocket = null;
      publishStatus("offline");
      if (!stopped) reconnectTimer = setTimeout(connect, 3000);
    };
  };
  connect();
  return () => { stopped=true; if(reconnectTimer) clearTimeout(reconnectTimer); heartbeatSocket?.close(); heartbeatSocket=null; publishStatus("offline"); };
}
