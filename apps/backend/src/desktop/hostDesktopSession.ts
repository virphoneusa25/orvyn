/** Host Windows desktop — separate from cloud Linux Desktop and Browser. */

export type HostControlOwner = "orion" | "user" | "none";

export interface HostDesktopState {
  allowed: boolean;
  controlling: boolean;
  controlOwner: HostControlOwner;
  lastAction?: string;
  lastError?: string;
  platform: string;
}

let allowed = process.env.ORVYN_HOST_DESKTOP === "1";
let controlOwner: HostControlOwner = "none";
let lastAction: string | undefined;
let lastError: string | undefined;

export function isHostDesktopAllowed(): boolean {
  return allowed;
}

export function setHostDesktopAllowed(value: boolean): HostDesktopState {
  allowed = value;
  if (!allowed) {
    controlOwner = "none";
    lastAction = undefined;
  }
  return getHostDesktopState();
}

export function getHostDesktopState(): HostDesktopState {
  return {
    allowed,
    controlling: allowed && controlOwner === "orion",
    controlOwner,
    lastAction,
    lastError,
    platform: process.platform,
  };
}

export function takeHostControl(): HostDesktopState {
  controlOwner = "user";
  lastAction = "user_take_control";
  return getHostDesktopState();
}

export function returnHostControl(): HostDesktopState {
  if (allowed) controlOwner = "orion";
  lastAction = "return_to_orion";
  return getHostDesktopState();
}

export function beginHostAgentAction(action: string): { ok: true } | { ok: false; error: string } {
  if (!allowed) {
    return { ok: false, error: "Host desktop control is off. Enable “Allow ORION to control this computer” in Settings." };
  }
  if (controlOwner === "user") {
    return { ok: false, error: "User took control. ORION host input is paused until Return to ORION." };
  }
  controlOwner = "orion";
  lastAction = action;
  lastError = undefined;
  return { ok: true };
}

export function failHostAction(error: string): void {
  lastError = error;
}
