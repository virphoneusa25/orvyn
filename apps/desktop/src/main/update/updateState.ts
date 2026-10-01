export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error"
  | "required";

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond?: number;
}

export interface DesktopUpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  channel: "stable" | "beta" | "canary";
  autoCheck: boolean;
  autoDownload: boolean;
  installOnExit: boolean;
  packaged: boolean;
  lastCheckedAt?: number;
  progress?: UpdateProgress;
  releaseNotes?: string;
  releaseDate?: string;
  required: boolean;
  minimumSupportedVersion?: string;
  error?: string;
  installOnExitArmed: boolean;
}

export type UpdateEvent =
  | { type: "reset"; currentVersion: string; channel: DesktopUpdateState["channel"]; packaged: boolean }
  | { type: "prefs"; autoCheck: boolean; autoDownload: boolean; installOnExit: boolean; channel: DesktopUpdateState["channel"] }
  | { type: "checking" }
  | { type: "available"; version: string; notes?: string; date?: string }
  | { type: "not_available" }
  | { type: "progress"; progress: UpdateProgress }
  | { type: "downloaded"; version?: string }
  | { type: "error"; message: string }
  | { type: "policy"; required: boolean; minimumSupportedVersion?: string; latest?: string; notes?: string }
  | { type: "install_on_exit"; armed: boolean };

export function initialUpdateState(input: {
  currentVersion: string;
  channel: DesktopUpdateState["channel"];
  packaged: boolean;
}): DesktopUpdateState {
  return {
    status: "idle",
    currentVersion: input.currentVersion,
    channel: input.channel,
    autoCheck: true,
    autoDownload: false,
    installOnExit: true,
    packaged: input.packaged,
    required: false,
    installOnExitArmed: false,
  };
}

export function reduceUpdate(state: DesktopUpdateState, event: UpdateEvent): DesktopUpdateState {
  switch (event.type) {
    case "reset":
      return { ...initialUpdateState(event), autoCheck: state.autoCheck, autoDownload: state.autoDownload, installOnExit: state.installOnExit };
    case "prefs":
      return { ...state, autoCheck: event.autoCheck, autoDownload: event.autoDownload, installOnExit: event.installOnExit, channel: event.channel };
    case "checking":
      return { ...state, status: state.required ? "required" : "checking", error: undefined };
    case "available":
      return {
        ...state,
        status: state.required ? "required" : "available",
        availableVersion: event.version,
        releaseNotes: sanitizeNotes(event.notes),
        releaseDate: event.date,
        lastCheckedAt: Date.now(),
        error: undefined,
      };
    case "not_available":
      return {
        ...state,
        status: state.required ? "required" : "not_available",
        lastCheckedAt: Date.now(),
        error: undefined,
      };
    case "progress":
      return { ...state, status: "downloading", progress: event.progress };
    case "downloaded":
      return {
        ...state,
        status: "downloaded",
        availableVersion: event.version ?? state.availableVersion,
        progress: state.progress ? { ...state.progress, percent: 100 } : undefined,
      };
    case "error":
      return { ...state, status: state.required ? "required" : "error", error: event.message };
    case "policy": {
      const required = event.required;
      return {
        ...state,
        required,
        minimumSupportedVersion: event.minimumSupportedVersion,
        availableVersion: event.latest ?? state.availableVersion,
        releaseNotes: event.notes != null ? sanitizeNotes(event.notes) : state.releaseNotes,
        status: required ? "required" : state.status === "required" ? "idle" : state.status,
      };
    }
    case "install_on_exit":
      return { ...state, installOnExitArmed: event.armed, installOnExit: event.armed || state.installOnExit };
    default:
      return state;
  }
}

export function sanitizeNotes(raw?: string): string | undefined {
  if (!raw) return undefined;
  return String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export function publicUpdateState(state: DesktopUpdateState): DesktopUpdateState {
  const { error, ...rest } = state;
  return {
    ...rest,
    error: error ? userFacingUpdateError(error) : undefined,
  };
}

export function userFacingUpdateError(raw: string): string {
  const m = String(raw ?? "").toLowerCase();
  if (/signature|code sign|not signed|checksum|sha512|integrity|xml/.test(m)) {
    return "The downloaded update could not be verified. It was not installed.";
  }
  if (/enospc|disk|space/.test(m)) return "There isn't enough disk space to download this update.";
  if (/eacces|eperm|permission/.test(m)) return "ORVYN doesn't have permission to install this update.";
  if (/404|not found|no update/.test(m)) return "Couldn't check for updates. ORVYN will try again later.";
  if (/network|offline|enotfound|econn|aborted|timeout|http.?5\d\d|502|503|500/.test(m)) {
    return "Couldn't check for updates. ORVYN will try again later.";
  }
  return "Couldn't check for updates. ORVYN will try again later.";
}

/** Missing or unreachable feed — retry later, do not block the workspace. */
export function isTransientUpdateFailure(raw: string): boolean {
  const m = String(raw ?? "").toLowerCase();
  if (/signature|code sign|not signed|checksum|sha512|integrity|enospc|disk|space|eacces|eperm|permission/.test(m)) {
    return false;
  }
  return /404|not found|no update|cannot find|latest\.yml|enotfound|econn|aborted|timeout|network|offline|http.?[45]\d\d|status code 5|502|503|500|internal server/.test(m);
}
