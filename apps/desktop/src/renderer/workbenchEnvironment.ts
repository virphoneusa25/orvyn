// Shared Workbench environment. Every Files / Terminal / Browser / Ports
// view reads this — never scatter executionTarget checks in React.

export type WorkbenchEnvironment = "local" | "sandbox" | "cloud";

export function resolveWorkbenchEnvironment(input: {
  executionTarget?: string | null;
  executionActual?: string | null;
  cloudBackend?: boolean;
}): WorkbenchEnvironment {
  const actual = String(input.executionActual ?? input.executionTarget ?? "").toLowerCase();
  if (actual === "local_sandbox" || actual === "sandbox") return "sandbox";
  if (actual === "ovh_worker" || actual === "cloud" || actual === "cloud_control_plane") return "cloud";
  if (actual === "local_host" || actual === "local" || actual === "auto") return "local";
  if (input.cloudBackend && !actual) return "cloud";
  return "local";
}

export function environmentLabel(env: WorkbenchEnvironment): string {
  if (env === "sandbox") return "Sandbox";
  if (env === "cloud") return "Cloud";
  return "Local";
}

export function terminalTitle(env: WorkbenchEnvironment, index = 1): string {
  const base =
    env === "cloud" ? "Terminal · Cloud Worker" : env === "sandbox" ? "Terminal · Sandbox" : "Terminal · Local";
  return index > 1 ? `${base} ${index}` : base;
}

export function environmentSummary(env: WorkbenchEnvironment, opts?: {
  projectRoot?: string | null;
  runId?: string | null;
  workerName?: string | null;
}): {
  type: WorkbenchEnvironment;
  label: string;
  workingDirectory: string;
  installScript: string;
  startScript: string;
  runtime: string;
  limits: string;
} {
  const root = opts?.projectRoot?.trim() || (env === "local" ? "No project workspace attached" : "Virtual workspace");
  return {
    type: env,
    label: environmentLabel(env),
    workingDirectory: root,
    installScript: env === "cloud" ? "worker install" : "npm ci / project install",
    startScript: env === "cloud" ? "worker start" : "project start script",
    runtime: env === "cloud" ? (opts?.workerName || "OVH worker") : env === "sandbox" ? "Docker sandbox" : "This machine",
    limits: env === "sandbox" ? "Network none unless allowed · dropped caps" : env === "cloud" ? "Tenant-scoped worker" : "Host process",
  };
}
