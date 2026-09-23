/** Host Windows desktop — separate from cloud Linux Desktop and Browser. */

export type HostControlOwner = "orion" | "user" | "none";

export interface HostDesktopState {
  allowed: boolean;
  controlling: boolean;
  controlOwner: HostControlOwner;
  tenantId: string;
  lastAction?: string;
  lastError?: string;
  platform: string;
}

interface HostSlot {
  allowed: boolean;
  controlOwner: HostControlOwner;
  lastAction?: string;
  lastError?: string;
}

const slots = new Map<string, HostSlot>();

function slot(tenantId: string): HostSlot {
  const id = String(tenantId || "").trim() || "default";
  let current = slots.get(id);
  if (!current) {
    current = {
      allowed: process.env.ORVYN_HOST_DESKTOP === "1",
      controlOwner: "none",
    };
    slots.set(id, current);
  }
  return current;
}

export function isHostDesktopAllowed(tenantId: string): boolean {
  return slot(tenantId).allowed;
}

export function setHostDesktopAllowed(tenantId: string, value: boolean): HostDesktopState {
  const current = slot(tenantId);
  current.allowed = value;
  if (!value) {
    current.controlOwner = "none";
    current.lastAction = undefined;
  }
  return getHostDesktopState(tenantId);
}

export function getHostDesktopState(tenantId: string): HostDesktopState {
  const current = slot(tenantId);
  return {
    allowed: current.allowed,
    controlling: current.allowed && current.controlOwner === "orion",
    controlOwner: current.controlOwner,
    tenantId: String(tenantId || "").trim() || "default",
    lastAction: current.lastAction,
    lastError: current.lastError,
    platform: process.platform,
  };
}

export function takeHostControl(tenantId: string): HostDesktopState {
  const current = slot(tenantId);
  current.controlOwner = "user";
  current.lastAction = "user_take_control";
  return getHostDesktopState(tenantId);
}

export function returnHostControl(tenantId: string): HostDesktopState {
  const current = slot(tenantId);
  if (current.allowed) current.controlOwner = "orion";
  current.lastAction = "return_to_orion";
  return getHostDesktopState(tenantId);
}

export function beginHostAgentAction(tenantId: string, action: string): { ok: true } | { ok: false; error: string } {
  const current = slot(tenantId);
  if (!current.allowed) {
    return { ok: false, error: "Host desktop control is off. Enable “Allow ORION to control this computer” in Settings." };
  }
  if (current.controlOwner === "user") {
    return { ok: false, error: "User took control. ORION host input is paused until Return to ORION." };
  }
  current.controlOwner = "orion";
  current.lastAction = action;
  current.lastError = undefined;
  return { ok: true };
}

export function failHostAction(tenantId: string, error: string): void {
  slot(tenantId).lastError = error;
}
