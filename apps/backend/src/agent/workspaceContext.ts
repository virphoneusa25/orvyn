import { existsSync } from "fs";
import path from "path";

export interface WorkspaceContext {
  path: string;
  available: boolean;
  repositoryDetected: boolean;
  repositoryRoot: string | null;
}

/** A project name is not a workspace. Git tools need a real repository root. */
export function inspectWorkspace(projectRoot: string): WorkspaceContext {
  const raw = String(projectRoot || "").trim();
  // Never treat a missing root as the backend process directory.
  if (!raw || raw === "." || raw === "./") {
    return { path: raw, available: false, repositoryDetected: false, repositoryRoot: null };
  }
  const start = path.resolve(raw);
  if (!existsSync(start)) {
    return { path: start, available: false, repositoryDetected: false, repositoryRoot: null };
  }
  let current = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(current, ".git"))) {
      return { path: start, available: true, repositoryDetected: true, repositoryRoot: current };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { path: start, available: true, repositoryDetected: false, repositoryRoot: null };
}
