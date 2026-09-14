export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface WorkspaceState {
  root: string;
  kind: "folder" | "default";
  recents: string[];
  fileRelative?: string;
}

export interface OrvynBridge {
  project: {
    getWorkspace(): Promise<WorkspaceState>;
    open(): Promise<WorkspaceState | null>;
    openPath(folder: string): Promise<WorkspaceState | null>;
    openFile(): Promise<WorkspaceState | null>;
    close(): Promise<WorkspaceState>;
    listDirectory(relativePath: string): Promise<DirEntry[]>;
    readFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<boolean>;
  };
  config: {
    get(): Promise<{ backendUrl: string; apiKey: string }>;
    set(config: { backendUrl: string; apiKey: string }): Promise<{ backendUrl: string; apiKey: string }>;
  };
}

declare global {
  interface Window {
    orvyn: OrvynBridge;
  }
}
