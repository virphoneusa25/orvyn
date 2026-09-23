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
  localWorker?: {
    status(): Promise<{ state: "ready" | "degraded" | "offline"; detail?: string; hostDesktopAllowed: boolean }>;
    setHostDesktop(allowed: boolean): Promise<{ state: "ready" | "degraded" | "offline"; detail?: string; hostDesktopAllowed: boolean }>;
  };
  engine?: {
    ensureLocal(): Promise<{ ok: boolean }>;
  };
  marketplace?: {
    officialSearch(query: string, limit?: number, cursor?: string): Promise<{ ok: boolean; status?: number; body: unknown; error?: string }>;
  };
  browser?: {
    list(): Promise<WorkbenchBrowserState>;
    create(kind?: "browser" | "preview", url?: string): Promise<WorkbenchBrowserState>;
    navigate(id: string, url: string): Promise<WorkbenchBrowserState>;
    back(id: string): Promise<WorkbenchBrowserState>;
    forward(id: string): Promise<WorkbenchBrowserState>;
    reload(id: string): Promise<WorkbenchBrowserState>;
    activate(id: string | null): Promise<WorkbenchBrowserState>;
    close(id: string): Promise<WorkbenchBrowserState>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<WorkbenchBrowserState>;
    setVisible(visible: boolean): Promise<WorkbenchBrowserState>;
    takeControl(id: string): Promise<WorkbenchBrowserState>;
    returnControl(id: string): Promise<WorkbenchBrowserState>;
    openExternal(id: string): Promise<boolean>;
    clearData(): Promise<WorkbenchBrowserState>;
    openDevTools(id: string): Promise<boolean>;
    inspect(id: string): Promise<{ ok: boolean; url?: string; title?: string; outline?: string; error?: string }>;
    onChange(cb: (state: WorkbenchBrowserState) => void): () => void;
  };
}

export interface WorkbenchBrowserTab {
  id: string;
  kind: "browser" | "preview";
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  controlOwner: "orion" | "user";
  error?: { code: string; description: string };
  console: string[];
  network: { method: string; url: string; status?: number }[];
  download?: { filename: string; received: number; total: number; state: string };
}

export interface WorkbenchBrowserRecent {
  url: string;
  title: string;
  favicon?: string;
  lastVisitedAt: number;
}

export interface WorkbenchBrowserState {
  tabs: WorkbenchBrowserTab[];
  recents: WorkbenchBrowserRecent[];
  activeId: string | null;
}

declare global {
  interface Window {
    orvyn: OrvynBridge;
  }
}
