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
  /** ArtifactService identity. Never treat this as a project path. */
  artifactId?: string;
  /** The operation that produced it (read/edit/create/delete). */
  op?: string;
  /** The page a browser row visited. */
  url?: string;
}

// The Workbench listens only while it is on screen. A click while it is closed
// opens it (App) and leaves the target here for it to pick up once mounted;
// before, that click opened an empty panel and the target was lost.
let pending: ArtifactTarget | null = null;
let listening = 0;

/** AgentWorkspace calls this while it listens; returns the unregister. */
export function registerContextListener(): () => void {
  listening++;
  return () => { listening = Math.max(0, listening - 1); };
}

/** The target clicked while the Workbench was closed, once. */
export function takePendingContext(): ArtifactTarget | null {
  const p = pending;
  pending = null;
  return p;
}

export function openArtifactInContext(target: ArtifactTarget): void {
  if (listening === 0) pending = target;
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
