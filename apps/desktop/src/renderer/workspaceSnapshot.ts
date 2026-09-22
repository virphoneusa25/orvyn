// apps/desktop/src/renderer/workspaceSnapshot.ts
//
// Live workspace facts for the Add menu. Contents are paths and line ranges
// only — never file bodies or secrets.

export interface EditorSelection {
  path: string;
  startLine: number;
  endLine: number;
  text?: string;
}

export interface WorkspaceSnapshotState {
  root: string | null;
  name: string | null;
  kind: "folder" | "default" | null;
  recents: string[];
  openTabs: string[];
  activePath: string | null;
}

let snapshot: WorkspaceSnapshotState = {
  root: null,
  name: null,
  kind: null,
  recents: [],
  openTabs: [],
  activePath: null,
};

let selectionReader: (() => EditorSelection | null) | null = null;

export function setWorkspaceSnapshot(next: Partial<WorkspaceSnapshotState>): WorkspaceSnapshotState {
  snapshot = { ...snapshot, ...next };
  return snapshot;
}

export function getWorkspaceSnapshot(): WorkspaceSnapshotState {
  return snapshot;
}

export function registerSelectionReader(reader: (() => EditorSelection | null) | null): void {
  selectionReader = reader;
}

export function readEditorSelection(): EditorSelection | null {
  try {
    return selectionReader?.() ?? null;
  } catch {
    return null;
  }
}
