export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface VirideBridge {
  project: {
    open(): Promise<string | null>;
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
    viride: VirideBridge;
  }
}
