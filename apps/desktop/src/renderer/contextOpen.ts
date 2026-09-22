// apps/desktop/src/renderer/contextOpen.ts
//
// THE one controller for opening run artifacts in the Workbench.
// Every clickable row — tool rows, work groups, file chips — goes through
// openArtifactInContext(). AgentWorkspace is the listener.

export type ContextTab = "plan" | "files" | "diff" | "terminal" | "browser" | "review" | "documents" | "desktop" | "preview";

export interface ArtifactTarget {
  tab: ContextTab;
  /** Relative file path when the artifact is a file (Read/Edit/Create rows). */
  path?: string;
  /** Filename alone, for tolerant matching against event paths. */
  fileName?: string;
  /** The operation that produced it (read/edit/create/delete). */
  op?: string;
}

export function openArtifactInContext(target: ArtifactTarget): void {
  document.dispatchEvent(new CustomEvent<ArtifactTarget>("orvyn:context-open", { detail: target }));
}

/** Tolerant match: full relative path, or by filename when separators differ. */
export function matchesFile(candidate: string, target: { path?: string; fileName?: string }): boolean {
  if (target.path && candidate.replace(/\\/g, "/") === target.path.replace(/\\/g, "/")) return true;
  if (target.fileName) {
    const c = candidate.replace(/\\/g, "/");
    const f = target.fileName.replace(/\\/g, "/");
    return c === f || c.endsWith("/" + f);
  }
  return false;
}
