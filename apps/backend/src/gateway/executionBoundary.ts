// Cloud work stays inside the cloud workspace. Host paths and escapes are denied here,
// independent of which tools the model was shown.

const HOST =
  /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:home|etc|root|var|usr|opt|tmp)(?:\/|$))/;

export function cloudFilesystemDecision(
  executionTarget: string | undefined,
  rawPath: string,
  workspaceRoot: string
): { ok: true; path: string } | { ok: false; code: "CROSS_EXECUTION_BOUNDARY"; error: string } {
  if (executionTarget !== "cloud_worker") return { ok: true, path: rawPath };
  const path = String(rawPath ?? "").trim().replace(/\\/g, "/");
  if (!path || HOST.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
    return {
      ok: false,
      code: "CROSS_EXECUTION_BOUNDARY",
      error: "Cloud runs cannot use a host path or leave the cloud workspace.",
    };
  }
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && path.startsWith(root + "/") && path.slice(root.length + 1).split("/").includes("..")) {
    return {
      ok: false,
      code: "CROSS_EXECUTION_BOUNDARY",
      error: "Cloud runs cannot use a host path or leave the cloud workspace.",
    };
  }
  return { ok: true, path };
}
