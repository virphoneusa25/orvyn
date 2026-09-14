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
