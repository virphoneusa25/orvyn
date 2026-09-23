// Execution target is WHERE work runs. It is not a run mode.
// Run mode stays Auto / Code / Server / Research / Deploy / Automate.

export type ExecutionTarget = "auto" | "local_host" | "local_sandbox" | "ovh_worker";
export type ResolvedExecutionTarget = Exclude<ExecutionTarget, "auto">;

export const EXECUTION_TARGETS: ExecutionTarget[] = ["auto", "local_host", "local_sandbox", "ovh_worker"];

export function isExecutionTarget(value: unknown): value is ExecutionTarget {
  return typeof value === "string" && (EXECUTION_TARGETS as string[]).includes(value);
}

export interface ExecutionRouteInput {
  requested?: unknown;
  /** Composer run mode — not an execution target. */
  mode?: string;
  hasLocalProject?: boolean;
  /** Untrusted / destructive / isolation-required command. */
  isRisky?: boolean;
  /** Long-running background / cloud mission. */
  isBackground?: boolean;
  /** Explicit server / OVH / deploy that must leave the machine. */
  requiresRemote?: boolean;
}

export interface ExecutionRoute {
  requested: ExecutionTarget;
  actual: ResolvedExecutionTarget;
  reason: string;
}

/**
 * Deterministic Auto routing. Health / availability is checked separately —
 * this function never silently swaps Local ↔ Cloud.
 *
 * Auto:
 *   explicit Server/Deploy requiring remote → ovh_worker
 *   background / cloud mission             → ovh_worker
 *   risky / untrusted                      → local_sandbox
 *   local project + normal coding          → local_host
 *   no local project                       → ovh_worker
 */
export function routeExecutionTarget(input: ExecutionRouteInput = {}): ExecutionRoute {
  const requested = isExecutionTarget(input.requested) ? input.requested : "auto";
  if (requested !== "auto") {
    return {
      requested,
      actual: requested,
      reason: requested === "local_host"
        ? "User selected Local — tools stay on this machine"
        : requested === "local_sandbox"
          ? "User selected Sandbox — isolated Docker on this machine"
          : "User selected Cloud — OVH worker, no local fallback",
    };
  }

  const mode = String(input.mode ?? "auto").toLowerCase();
  const requiresRemote =
    input.requiresRemote === true || mode === "server" || mode === "deploy";
  if (requiresRemote) {
    return {
      requested,
      actual: "ovh_worker",
      reason: mode === "deploy"
        ? "Deploy mode requires remote / OVH execution"
        : "Server mode requires a remote OVH worker",
    };
  }
  if (input.isBackground) {
    return { requested, actual: "ovh_worker", reason: "Background / cloud mission" };
  }
  if (input.isRisky) {
    return { requested, actual: "local_sandbox", reason: "Untrusted or isolation-required command" };
  }
  if (input.hasLocalProject) {
    return { requested, actual: "local_host", reason: "Local project + normal coding" };
  }
  return { requested, actual: "ovh_worker", reason: "No local project bound — remote execution" };
}

export function executionLabel(target: ResolvedExecutionTarget): string {
  if (target === "local_host") return "Local";
  if (target === "local_sandbox") return "Local Sandbox";
  return "OVH Worker";
}

export function runtimeLocation(
  actual: ResolvedExecutionTarget,
  opts: { inProcessLocal?: boolean } = {}
): "LOCAL" | "LOCAL_HOST" | "LOCAL_SANDBOX" | "OVH_WORKER" {
  if (actual === "ovh_worker") return "OVH_WORKER";
  if (actual === "local_sandbox") return "LOCAL_SANDBOX";
  if (opts.inProcessLocal) return "LOCAL";
  return "LOCAL_HOST";
}
