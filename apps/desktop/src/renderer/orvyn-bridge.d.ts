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

export interface ChatAttachment {
  path: string;
  kind: "text" | "image";
  purpose?: "reference" | "review" | "edit";
  content?: string;
  mime?: string;
  dataUrl?: string;
  sourcePath?: string;
}

export interface OrvynBridge {
  system: {
    getStats(): Promise<{ cpuPercent: number; ramPercent: number; diskPercent: number }>;
    getIdentity?(): Promise<{ name: string }>;
  };
  terminal: {
    start(): Promise<string>;
    write(sessionId: string, input: string): Promise<boolean>;
    kill(sessionId: string): Promise<boolean>;
    onData(cb: (e: { sessionId: string; data: string }) => void): () => void;
  };
  project: {
    getWorkspace(): Promise<WorkspaceState>;
    open(): Promise<WorkspaceState | null>;
    openPath(folder: string): Promise<WorkspaceState | null>;
    openFile(): Promise<WorkspaceState | null>;
    close(): Promise<WorkspaceState>;
    listDirectory(relativePath: string): Promise<DirEntry[]>;
    listFiles(): Promise<string[]>;
    readFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<boolean>;
    readBinary(relativePath: string): Promise<ChatAttachment | null>;
  };
  attachments: {
    pick(): Promise<ChatAttachment[]>;
    pickFolder(): Promise<{ path: string; name: string } | { error: string } | null>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    getState(): Promise<{ maximized: boolean }>;
    saveText(payload: { defaultName?: string; content: string }): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
    writeClipboard?(text: string): Promise<boolean>;
    openExternal?(url: string): Promise<boolean>;
    toggleDevTools(): Promise<void>;
    reload(): Promise<void>;
    onMaximizedChange(cb: (v: boolean) => void): () => void;
  };
  chats: {
    load(): Promise<{ sessions: unknown[] }>;
    save(data: unknown): Promise<boolean>;
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
