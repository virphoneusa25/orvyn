// Local Electron Workbench browser. When registered, browser_* tools drive
// the visible WebContentsView instead of a hidden Playwright session.

import { sendWorkbenchBrowserCommand, workbenchBrowserOnline, type BrowserBridgeCommand } from "./workbenchBrowserBridge";

export interface ElectronBrowserTarget {
  tenantId: string;
  url: string;
  token: string;
  registeredAt: number;
}

const targets = new Map<string, ElectronBrowserTarget>();

export function setElectronBrowserTarget(tenantId: string, url: string, token: string): ElectronBrowserTarget {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(url)) {
    throw new Error("Electron browser target must be a loopback http://127.0.0.1 port.");
  }
  if (!token || token.length < 8 || token.length > 128) throw new Error("Invalid browser token.");
  const next = { tenantId, url, token, registeredAt: Date.now() };
  targets.set(tenantId, next);
  return next;
}

export function getElectronBrowserTarget(tenantId: string): ElectronBrowserTarget | undefined {
  return targets.get(tenantId);
}

export async function callElectronBrowser(
  tenantId: string,
  path: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  const target = targets.get(tenantId);
  if (!target) return null;
  try {
    const res = await fetch(`${target.url}${path}`, {
      method: path.endsWith("/state") ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orvyn-Browser-Token": target.token,
      },
      body: path.endsWith("/state") ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One browser command to the user's Workbench Browser session. The Local
 * Worker bridge works for any control plane (cloud or local); the loopback
 * target is the same-machine shortcut. null: no Workbench Browser connected.
 */
export async function workbenchBrowserCommand(
  tenantId: string,
  command: BrowserBridgeCommand
): Promise<Record<string, unknown> | null> {
  if (!tenantId) return null;
  if (workbenchBrowserOnline(tenantId)) return sendWorkbenchBrowserCommand(tenantId, command);
  const target = targets.get(tenantId);
  if (!target) return null;
  try {
    const res = await fetch(`${target.url}/v1/browser/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orvyn-Browser-Token": target.token },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resetElectronBrowserTargetsForTests(): void {
  targets.clear();
}
