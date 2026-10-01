export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error"
  | "required";

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
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond?: number };
  releaseNotes?: string;
  releaseDate?: string;
  required: boolean;
  minimumSupportedVersion?: string;
  error?: string;
  installOnExitArmed: boolean;
}

export function cloudMissionsBlockedByUpdate(state: { required?: boolean } | null | undefined): boolean {
  return state?.required === true;
}
