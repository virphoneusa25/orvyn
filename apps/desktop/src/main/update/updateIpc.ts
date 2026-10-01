export const UPDATE_IPC = {
  getState: "updates:getState",
  check: "updates:check",
  download: "updates:download",
  restartAndInstall: "updates:restartAndInstall",
  installOnExit: "updates:installOnExit",
  setChannel: "updates:setChannel",
  setAutoDownload: "updates:setAutoDownload",
  setAutoCheck: "updates:setAutoCheck",
  setInstallOnExit: "updates:setInstallOnExit",
  setWorkBusy: "updates:setWorkBusy",
  dismiss: "updates:dismiss",
  changed: "updates:changed",
} as const;

export type UpdateIpcName = (typeof UPDATE_IPC)[keyof typeof UPDATE_IPC];

export function isUpdateIpc(channel: string): boolean {
  return Object.values(UPDATE_IPC).includes(channel as UpdateIpcName);
}

/** IPC cannot run arbitrary shell; only these named handlers exist. */
export const UPDATE_IPC_COMMANDS = Object.values(UPDATE_IPC).filter((c) => c !== UPDATE_IPC.changed);

export function parseBooleanArg(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  return null;
}

export function parseRestartArg(raw: unknown): { force: boolean } {
  if (!raw || typeof raw !== "object") return { force: false };
  return { force: (raw as { force?: unknown }).force === true };
}
